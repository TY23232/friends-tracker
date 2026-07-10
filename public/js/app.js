const API = window.location.origin;
let socket = null;
let currentUser = null;
let currentGroup = null;
let userGroups = [];
let onlineStatus = {};
let mapInstance = null;
let markers = {};
let infoWindows = {};

function getUser() {
  const data = localStorage.getItem('user');
  if (data) {
    currentUser = JSON.parse(data);
    return currentUser;
  }
  return null;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
}

async function initDashboard() {
  const user = getUser();
  if (!user) {
    window.location.href = '/';
    return;
  }

  document.getElementById('userInfo').textContent = `${user.name} (${user.email})`;

  if (typeof google === 'undefined') {
    try {
      const config = await fetch('/config.json').then(r => r.json()).catch(() => ({}));
      const apiKey = config.googleMapsApiKey || '';

      if (apiKey) {
        await loadScript(`https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,geometry`);
      } else {
        console.warn('Google Maps API key not configured. Map features disabled.');
        document.getElementById('map').innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;height:100%;padding:40px;text-align:center;color:#666;">
            <div>
              <h3>Google Maps API Key Required</h3>
              <p style="margin-top:8px;">Set your API key in the .env file as GOOGLE_MAPS_API_KEY</p>
              <p style="margin-top:4px;font-size:13px;">Get one at <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a></p>
            </div>
          </div>`;
        return;
      }
    } catch (e) {
      console.error('Failed to load Google Maps:', e);
    }
  }

  if (typeof google !== 'undefined' && google.maps) {
    initMap();
  }

  await loadGroups();
  connectSocket();
}

function connectSocket() {
  socket = io(API, { transports: ['polling', 'websocket'] });

  socket.on('connect', () => {
    if (currentUser && currentGroup) {
      socket.emit('user:join', { userId: currentUser.id, groupId: currentGroup.id });
    }
  });

  socket.on('location:updated', (data) => {
    updateMemberLocation(data.userId, data.location);
  });

  socket.on('user:online', ({ userId, online }) => {
    onlineStatus[userId] = online;
    updateMemberStatus(userId, online);
  });

  socket.on('member:joined', ({ userId, name }) => {
    if (currentGroup && !currentGroup.members.find(m => m.userId === userId)) {
      currentGroup.members.push({ userId, name });
      renderMembers();
    }
  });

  socket.on('ping:received', ({ fromName }) => {
    showNotification(`${fromName} is checking on you!`, 'info');
  });

  socket.on('location:request:response', ({ userId, name, location }) => {
    if (location) {
      updateMemberLocation(userId, location);
      showNotification(`${name} shared their location`, 'success');
    }
  });

  socket.on('ping:acknowledged', ({ name }) => {
    showNotification(`${name} acknowledged your ping`, 'success');
  });

  socket.on('eta:unavailable', ({ name, reason }) => {
    showNotification(`Cannot calculate ETA for ${name}: ${reason}`, 'error');
  });

  socket.on('eta:calculated', ({ userId, name, originLat, originLng, destinationLat, destinationLng }) => {
    if (typeof google !== 'undefined' && google.maps) {
      calculateAndShowETA(name, originLat, originLng, destinationLat, destinationLng);
    }
  });
}

async function loadGroups() {
  if (!currentUser) return;
  try {
    const res = await fetch(`${API}/api/groups?userId=${currentUser.id}`);
    const data = await res.json();
    userGroups = data.groups;
    renderGroups();
    if (userGroups.length > 0) {
      selectGroup(userGroups[0].id);
    }
  } catch (err) {
    console.error('Failed to load groups:', err);
  }
}

function renderGroups() {
  const list = document.getElementById('groupsList');
  list.innerHTML = userGroups.map(g => `
    <div class="group-item ${currentGroup && currentGroup.id === g.id ? 'active' : ''}"
         onclick="selectGroup('${g.id}')">
      <div>
        <div class="group-name">${g.name}</div>
        <div class="group-meta">${g.members.length} member${g.members.length !== 1 ? 's' : ''}</div>
      </div>
    </div>
  `).join('');
}

async function selectGroup(groupId) {
  const user = getUser();
  if (!user) return;

  try {
    const res = await fetch(`${API}/api/groups/${groupId}`);
    const data = await res.json();
    currentGroup = data.group;
    document.getElementById('currentGroupName').textContent = currentGroup.name;
    document.getElementById('membersSection').style.display = 'block';
    document.getElementById('pingSection').style.display = 'none';

    document.querySelectorAll('.group-item').forEach(el => el.classList.remove('active'));
    const groupEl = document.querySelectorAll('.group-item');
    const idx = userGroups.findIndex(g => g.id === groupId);
    if (groupEl[idx]) groupEl[idx].classList.add('active');

    renderMembers();
    renderPings();

    if (socket && socket.connected) {
      socket.emit('user:join', { userId: user.id, groupId });
    }

    if (typeof google !== 'undefined' && google.maps && mapInstance) {
      updateMapMarkers();
    }

    if (window.innerWidth <= 900) {
      toggleSidebar();
    }
  } catch (err) {
    console.error('Failed to load group:', err);
  }
}

function renderMembers() {
  if (!currentGroup) return;
  const list = document.getElementById('membersList');

  list.innerHTML = currentGroup.members.map(m => {
    const isSelf = m.userId === currentUser.id;
    const initials = m.name.split(' ').map(s => s[0]).join('').toUpperCase().slice(0, 2);
    const status = onlineStatus[m.userId] !== undefined ? onlineStatus[m.userId] : false;

    return `
      <div class="member-item">
        <div class="member-info">
          <div class="member-avatar">${initials}</div>
          <div class="member-details">
            <div class="member-name">${m.name} ${isSelf ? '(You)' : ''}</div>
            <div class="member-status ${status ? 'online' : 'offline'}">
              ${status ? '● Online' : '○ Offline'}
            </div>
          </div>
        </div>
        ${!isSelf ? `
          <div class="member-actions">
            <button class="btn-ping" onclick="requestPing('${m.userId}')">Ping</button>
            <button class="btn-locate" onclick="requestLocation('${m.userId}')">Locate</button>
            <button class="btn-route" onclick="showRoute('${m.userId}')">Route</button>
            <button class="btn-eta" onclick="requestETA('${m.userId}')">ETA</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function updateMemberStatus(userId, online) {
  onlineStatus[userId] = online;
  if (currentGroup && currentGroup.members.find(m => m.userId === userId)) {
    renderMembers();
  }
}

function updateMemberLocation(userId, location) {
  if (!currentGroup || !currentGroup.members.find(m => m.userId === userId)) return;

  const member = currentGroup.members.find(m => m.userId === userId);
  if (member) member.location = location;

  if (typeof google !== 'undefined' && google.maps && mapInstance) {
    updateMarker(userId, location, member?.name || 'Unknown');
  }
}

function requestPing(targetUserId) {
  if (!socket || !currentUser || !currentGroup) return;
  socket.emit('ping:send', {
    fromUserId: currentUser.id,
    targetUserId,
    groupId: currentGroup.id
  });
  showNotification('Ping sent! Waiting for acknowledgment...', 'info');
}

function requestLocation(targetUserId) {
  if (!socket || !currentUser || !currentGroup) return;
  socket.emit('location:request', {
    fromUserId: currentUser.id,
    targetUserId,
    groupId: currentGroup.id
  });
  showNotification('Location request sent...', 'info');
}

function requestETA(targetUserId) {
  if (!socket || !currentUser || !currentGroup) return;

  const center = mapInstance ? mapInstance.getCenter() : null;
  if (center) {
    socket.emit('eta:request', {
      fromUserId: currentUser.id,
      targetUserId,
      groupId: currentGroup.id,
      destinationLat: center.lat(),
      destinationLng: center.lng()
    });
  } else {
    const member = currentGroup.members.find(m => m.userId === currentUser.id);
    if (member && member.location) {
      socket.emit('eta:request', {
        fromUserId: currentUser.id,
        targetUserId,
        groupId: currentGroup.id,
        destinationLat: member.location.lat,
        destinationLng: member.location.lng
      });
    }
  }
  showNotification('Requesting ETA...', 'info');
}

function renderPings() {
  const list = document.getElementById('pingList');
  list.innerHTML = '';
}

function showCreateGroup() {
  document.getElementById('createGroupModal').style.display = 'flex';
  document.getElementById('groupName').value = '';
}

async function createGroup() {
  const name = document.getElementById('groupName').value.trim();
  if (!name || !currentUser) return;

  try {
    const res = await fetch(`${API}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    closeModal('createGroupModal');
    await loadGroups();
    selectGroup(data.group.id);
  } catch (err) {
    alert('Failed to create group: ' + err.message);
  }
}

async function showInvite() {
  if (!currentGroup) return;
  try {
    const res = await fetch(`${API}/api/groups/${currentGroup.id}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    document.getElementById('inviteCode').textContent = data.inviteCode;
    document.getElementById('inviteLink').textContent = data.inviteLink;
    document.getElementById('inviteModal').style.display = 'flex';
  } catch (err) {
    alert('Failed to generate invite: ' + err.message);
  }
}

function copyInvite() {
  const link = document.getElementById('inviteLink').textContent;
  navigator.clipboard.writeText(link).then(() => {
    showNotification('Invite link copied!', 'success');
  }).catch(() => {
    const code = document.getElementById('inviteCode').textContent;
    navigator.clipboard.writeText(code).then(() => {
      showNotification('Invite code copied!', 'success');
    });
  });
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

function showNotification(message, type = 'info') {
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.style.cssText = `
    background: ${type === 'success' ? '#e8f5e9' : type === 'error' ? '#ffebee' : '#e3f2fd'};
    color: ${type === 'success' ? '#2e7d32' : type === 'error' ? '#c62828' : '#1565c0'};
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.location.pathname.includes('dashboard.html')) {
    if (!getUser()) {
      window.location.href = '/';
      return;
    }
    initDashboard();
  }
});