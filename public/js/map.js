function initMap() {
  const defaultCenter = { lat: 39.8283, lng: -98.5795 };

  mapInstance = new google.maps.Map(document.getElementById('map'), {
    zoom: 4,
    center: defaultCenter,
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false,
    styles: [
      { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', elementType: 'labels', stylers: [{ visibility: 'off' }] }
    ]
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        mapInstance.setCenter(userPos);
        mapInstance.setZoom(10);
      },
      () => {},
      { timeout: 5000, enableHighAccuracy: true }
    );
  }

  if (currentGroup) {
    updateMapMarkers();
  }
}

function getMarkerIcon(userId, label) {
  const isSelf = currentUser && userId === currentUser.id;
  const colors = ['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#E91E63', '#00BCD4', '#FF5722', '#607D8B'];
  const colorIdx = userId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length;
  const color = colors[colorIdx];

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
      <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 26 18 26s18-12.5 18-26C36 8.06 27.94 0 18 0z" fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="18" cy="18" r="10" fill="white" opacity="0.9"/>
      <text x="18" y="22" text-anchor="middle" font-size="11" font-weight="bold" fill="${color}">${label}</text>
    </svg>
  `;

  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(36, 44),
    anchor: new google.maps.Point(18, 44)
  };
}

function updateMapMarkers() {
  if (!currentGroup || !mapInstance) return;

  currentGroup.members.forEach(m => {
    if (m.location) {
      updateMarker(m.userId, m.location, m.name);
    }
  });
}

function updateMarker(userId, location, name) {
  if (!mapInstance) return;

  const lat = typeof location.lat === 'function' ? location.lat() : location.lat;
  const lng = typeof location.lng === 'function' ? location.lng() : location.lng;
  const pos = new google.maps.LatLng(lat, lng);

  const initials = name.split(' ').map(s => s[0]).join('').toUpperCase().slice(0, 2);

  if (markers[userId]) {
    markers[userId].setPosition(pos);
    if (infoWindows[userId]) {
      infoWindows[userId].setContent(buildInfoContent(name, location));
    }
  } else {
    markers[userId] = new google.maps.Marker({
      position: pos,
      map: mapInstance,
      icon: getMarkerIcon(userId, initials),
      title: name,
      animation: google.maps.Animation.DROP
    });

    infoWindows[userId] = new google.maps.InfoWindow({
      content: buildInfoContent(name, location)
    });

    markers[userId].addListener('click', () => {
      Object.values(infoWindows).forEach(iw => iw.close());
      infoWindows[userId].open(mapInstance, markers[userId]);
    });
  }

  if (currentUser && userId === currentUser.id) {
    mapInstance.setCenter(pos);
  }
}

function buildInfoContent(name, location) {
  const lat = typeof location.lat === 'function' ? location.lat() : location.lat;
  const lng = typeof location.lng === 'function' ? location.lng() : location.lng;
  const time = location.timestamp ? new Date(location.timestamp).toLocaleTimeString() : 'Just now';
  const speed = location.speed ? `${(location.speed * 3.6).toFixed(1)} km/h` : '--';
  const accuracy = location.accuracy ? `${location.accuracy.toFixed(0)}m` : '--';

  return `
    <div style="font-family:system-ui,sans-serif;padding:4px;min-width:180px;">
      <strong style="font-size:15px;">${name}</strong>
      <div style="font-size:12px;color:#666;margin-top:4px;">
        <div>Lat: ${lat.toFixed(6)}</div>
        <div>Lng: ${lng.toFixed(6)}</div>
        <div>Accuracy: ${accuracy}</div>
        <div>Speed: ${speed}</div>
        <div>Updated: ${time}</div>
      </div>
    </div>
  `;
}

let routeRenderer = null;
let routeWaypoints = [];

function showRoute(targetUserId) {
  if (!currentGroup || !mapInstance || !currentUser) return;

  const target = currentGroup.members.find(m => m.userId === targetUserId);
  if (!target || !target.location) {
    showNotification(`${target?.name || 'User'} has no location data yet`, 'error');
    return;
  }

  if (routeRenderer) routeRenderer.setMap(null);

  function drawRoute(originLat, originLng) {
    const origin = new google.maps.LatLng(originLat, originLng);
    const destination = new google.maps.LatLng(target.location.lat, target.location.lng);

    routeRenderer = new google.maps.DirectionsRenderer({
      map: mapInstance,
      suppressMarkers: true,
      polylineOptions: {
        strokeColor: '#4CAF50',
        strokeWeight: 5,
        strokeOpacity: 0.8
      }
    });

    const service = new google.maps.DirectionsService();
    service.route(
      { origin, destination, travelMode: google.maps.TravelMode.DRIVING },
      (result, status) => {
        if (status === 'OK') {
          routeRenderer.setDirections(result);
          document.getElementById('routeSection').style.display = 'block';
          const bounds = new google.maps.LatLngBounds();
          bounds.extend(origin);
          bounds.extend(destination);
          mapInstance.fitBounds(bounds);
          showNotification(`Route to ${target.name}: ${result.routes[0].legs[0].distance.text}`, 'success');
        } else {
          showNotification(`Route failed: ${status}`, 'error');
          routeRenderer.setMap(null);
          routeRenderer = null;
        }
      }
    );
  }

  const me = currentGroup.members.find(m => m.userId === currentUser.id);
  if (me && me.location) {
    drawRoute(me.location.lat, me.location.lng);
    return;
  }

  if (!navigator.geolocation) {
    showNotification('Cannot get your location', 'error');
    return;
  }

  showNotification('Getting your location...', 'info');
  navigator.geolocation.getCurrentPosition(
    (pos) => drawRoute(pos.coords.latitude, pos.coords.longitude),
    () => showNotification('Could not get your location. Share it first.', 'error'),
    { timeout: 10000, enableHighAccuracy: true }
  );
}

function clearRoute() {
  if (routeRenderer) {
    routeRenderer.setMap(null);
    routeRenderer = null;
  }
  document.getElementById('routeSection').style.display = 'none';
}

function calculateAndShowETA(name, originLat, originLng, destLat, destLng) {
  if (typeof google === 'undefined' || !google.maps) return;

  const origin = new google.maps.LatLng(originLat, originLng);
  const destination = new google.maps.LatLng(destLat, destLng);

  const service = new google.maps.DistanceMatrixService();
  service.getDistanceMatrix(
    {
      origins: [origin],
      destinations: [destination],
      travelMode: google.maps.TravelMode.DRIVING,
      unitSystem: google.maps.UnitSystem.METRIC,
      avoidHighways: false,
      avoidTolls: false
    },
    (response, status) => {
      if (status !== 'OK') {
        showNotification(`ETA unavailable: ${status}`, 'error');
        return;
      }

      const result = response.rows[0]?.elements[0];
      if (!result || result.status !== 'OK') {
        showNotification('Could not calculate route', 'error');
        return;
      }

      const distance = result.distance.text;
      const duration = result.duration.text;
      const durationInTraffic = result.duration_in_traffic?.text || duration;

      document.getElementById('etaTitle').textContent = `ETA for ${name}`;
      document.getElementById('etaDetails').innerHTML = `
        <p><strong>Distance:</strong> ${distance}</p>
        <p><strong>Duration:</strong> ${duration}</p>
        <p><strong>In Traffic:</strong> ${durationInTraffic}</p>
      `;

      const etaMapEl = document.getElementById('etaMap');
      const etaMap = new google.maps.Map(etaMapEl, {
        center: origin,
        zoom: 8,
        mapTypeControl: false,
        streetViewControl: false
      });

      new google.maps.Marker({ position: origin, map: etaMap, label: 'A', title: name });
      new google.maps.Marker({ position: destination, map: etaMap, label: 'B', title: 'Destination' });

      const directionsService = new google.maps.DirectionsService();
      const directionsRenderer = new google.maps.DirectionsRenderer({ map: etaMap, suppressMarkers: true });

      directionsService.route(
        { origin, destination, travelMode: google.maps.TravelMode.DRIVING },
        (dirResult, dirStatus) => {
          if (dirStatus === 'OK') {
            directionsRenderer.setDirections(dirResult);
          }
        }
      );

      document.getElementById('etaModal').style.display = 'flex';
    }
  );
}


