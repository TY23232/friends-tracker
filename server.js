require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  },
  transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load data:', e.message);
  }
  return { users: {}, groups: {}, locations: {}, memberGroups: {} };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users, groups, locations, memberGroups }, null, 2));
  } catch (e) {
    console.error('Failed to save data:', e.message);
  }
}

let { users, groups, locations, memberGroups } = loadData();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/config.json', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || ''
  });
});

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

app.post('/api/register', (req, res) => {
  const { email, name } = req.body;
  if (!email || !name) return res.status(400).json({ error: 'Email and name required' });

  const existing = Object.values(users).find(u => u.email === email);
  if (existing) {
    return res.json({ user: existing });
  }

  const userId = uuidv4();
  users[userId] = { id: userId, email, name, createdAt: Date.now() };
  saveData();
  res.json({ user: users[userId] });
});

app.post('/api/login', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const user = Object.values(users).find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'User not found. Please register first.' });
  res.json({ user });
});

app.post('/api/groups', (req, res) => {
  const { userId, name } = req.body;
  if (!userId || !name) return res.status(400).json({ error: 'userId and group name required' });
  if (!users[userId]) return res.status(404).json({ error: 'User not found' });

  const groupId = uuidv4();
  groups[groupId] = {
    id: groupId,
    name,
    ownerId: userId,
    members: [{ userId, name: users[userId].name, email: users[userId].email, joinedAt: Date.now() }],
    inviteCode: generateCode(),
    createdAt: Date.now()
  };
  memberGroups[userId] = memberGroups[userId] || [];
  memberGroups[userId].push(groupId);
  saveData();

  res.json({ group: groups[groupId] });
});

app.get('/api/groups', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const groupIds = memberGroups[userId] || [];
  const userGroups = groupIds.map(id => groups[id]).filter(Boolean);
  res.json({ groups: userGroups });
});

app.get('/api/groups/:id', (req, res) => {
  const group = groups[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const membersWithLocation = group.members.map(m => ({
    ...m,
    location: locations[m.userId] || null
  }));
  res.json({ group: { ...group, members: membersWithLocation } });
});

app.post('/api/groups/join/:code', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!users[userId]) return res.status(404).json({ error: 'User not found' });

  const group = Object.values(groups).find(g => g.inviteCode === req.params.code.toUpperCase());
  if (!group) return res.status(404).json({ error: 'Invalid invite code' });
  if (group.members.find(m => m.userId === userId)) return res.status(400).json({ error: 'Already a member' });

  group.members.push({ userId, name: users[userId].name, email: users[userId].email, joinedAt: Date.now() });
  memberGroups[userId] = memberGroups[userId] || [];
  memberGroups[userId].push(group.id);
  saveData();

  io.to(`group:${group.id}`).emit('member:joined', { userId, name: users[userId].name });
  res.json({ group });
});

app.post('/api/groups/:id/invite', (req, res) => {
  const group = groups[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json({ inviteCode: group.inviteCode, inviteLink: `${req.protocol}://${req.get('host')}/join.html?code=${group.inviteCode}` });
});

app.get('/api/user/:id', (req, res) => {
  const user = users[req.params.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

io.on('connection', (socket) => {
  let currentUserId = null;
  let currentGroupId = null;

  socket.on('user:join', ({ userId, groupId }) => {
    currentUserId = userId;
    currentGroupId = groupId;
    socket.join(`group:${groupId}`);

    if (userId && users[userId]) {
      socket.join(`user:${userId}`);
      io.to(`group:${groupId}`).emit('user:online', { userId, online: true });
    }
  });

  socket.on('location:update', ({ userId, groupId, lat, lng, accuracy, heading, speed, timestamp }) => {
    if (!userId || !groupId) return;

    locations[userId] = { lat, lng, accuracy, heading, speed, timestamp: timestamp || Date.now(), userId };
    saveData();

    socket.to(`group:${groupId}`).emit('location:updated', {
      userId,
      location: locations[userId]
    });
  });

  socket.on('location:request', ({ fromUserId, targetUserId, groupId }) => {
    io.to(`user:${targetUserId}`).emit('location:requested', {
      fromUserId,
      fromName: users[fromUserId]?.name || 'Unknown',
      groupId
    });
  });

  socket.on('location:request:response', ({ fromUserId, targetUserId, groupId, lat, lng }) => {
    if (lat && lng) {
      locations[targetUserId] = { lat, lng, timestamp: Date.now(), userId: targetUserId };
      saveData();
    }
    io.to(`user:${fromUserId}`).emit('location:request:response', {
      userId: targetUserId,
      name: users[targetUserId]?.name || 'Unknown',
      location: locations[targetUserId]
    });
  });

  socket.on('ping:send', ({ fromUserId, targetUserId, groupId }) => {
    io.to(`user:${targetUserId}`).emit('ping:received', {
      fromUserId,
      fromName: users[fromUserId]?.name || 'Unknown',
      groupId
    });
  });

  socket.on('ping:ack', ({ fromUserId, targetUserId, groupId }) => {
    io.to(`user:${fromUserId}`).emit('ping:acknowledged', {
      userId: targetUserId,
      name: users[targetUserId]?.name || 'Unknown'
    });
  });

  socket.on('eta:request', ({ fromUserId, targetUserId, groupId, destinationLat, destinationLng }) => {
    const targetLoc = locations[targetUserId];
    if (!targetLoc) {
      io.to(`user:${fromUserId}`).emit('eta:unavailable', { userId: targetUserId, reason: 'Location unknown' });
      return;
    }
    io.to(`user:${fromUserId}`).emit('eta:calculated', {
      userId: targetUserId,
      name: users[targetUserId]?.name || 'Unknown',
      originLat: targetLoc.lat,
      originLng: targetLoc.lng,
      destinationLat,
      destinationLng
    });
  });

  socket.on('disconnect', () => {
    if (currentUserId && currentGroupId) {
      io.to(`group:${currentGroupId}`).emit('user:online', { userId: currentUserId, online: false });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Friends Tracker running on port ${PORT}`);
  console.log(`Google Maps API Key configured: ${process.env.GOOGLE_MAPS_API_KEY ? 'Yes' : 'No - set GOOGLE_MAPS_API_KEY in .env'}`);
});
