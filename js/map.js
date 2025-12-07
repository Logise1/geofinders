export class MapManager {
    constructor() {
        this.map = null;
        this.userMarker = null;
        this.otherMarkers = {};
        this.stormCircle = null;
        this.safeZoneCircle = null;
        this.forceShowAll = false;
    }

    init(lat, lng) {
        // Dark Mode Map Style (CartoDB Dark Matter)
        this.map = L.map('map', {
            zoomControl: false,
            attributionControl: false
        }).setView([lat, lng], 18);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 20
        }).addTo(this.map);

        // Custom User Icon
        const userIcon = L.divIcon({
            className: 'user-marker',
            html: '<div class="pulse-marker"></div>',
            iconSize: [20, 20]
        });

        this.userMarker = L.marker([lat, lng], { icon: userIcon }).addTo(this.map);
    }

    updateUserPosition(lat, lng) {
        if (this.userMarker) {
            this.userMarker.setLatLng([lat, lng]);
            this.map.panTo([lat, lng], { animate: true, duration: 1 });
        }
    }

    updateOtherPlayers(players, currentUserId) {
        // Clear missing players
        Object.keys(this.otherMarkers).forEach(id => {
            if (!players[id] || players[id].dead) {
                this.map.removeLayer(this.otherMarkers[id]);
                delete this.otherMarkers[id];
            }
        });

        // Update/Add players
        Object.entries(players).forEach(([id, data]) => {
            if (id === currentUserId || data.dead) return;

            // Visibility Logic
            let isVisible = this.forceShowAll;

            // In a real app, check teamId here. 
            // For now, if not forceShowAll, we hide unless we implement other logic.
            // But to make the game playable for testing without waiting for reveal, 
            // maybe we show them if they are close? Or just stick to the rule.
            // The rule says: "Mueve por el mapa libremente. Cada 3 min se revela..."
            // This implies they are HIDDEN otherwise.

            if (!isVisible) {
                if (this.otherMarkers[id]) {
                    this.map.removeLayer(this.otherMarkers[id]);
                    delete this.otherMarkers[id];
                }
                return;
            }

            if (!this.otherMarkers[id]) {
                const enemyIcon = L.divIcon({
                    className: 'enemy-marker',
                    html: `<div class="enemy-dot"></div><span class="player-label">${data.name}</span>`,
                    iconSize: [20, 20]
                });
                this.otherMarkers[id] = L.marker([data.lat, data.lng], { icon: enemyIcon }).addTo(this.map);
            } else {
                this.otherMarkers[id].setLatLng([data.lat, data.lng]);
                if (!this.map.hasLayer(this.otherMarkers[id])) {
                    this.otherMarkers[id].addTo(this.map);
                }
            }
        });
    }

    drawStorm(centerLat, centerLng, radius) {
        if (this.stormCircle) {
            this.stormCircle.setLatLng([centerLat, centerLng]);
            this.stormCircle.setRadius(radius);
        } else {
            this.stormCircle = L.circle([centerLat, centerLng], {
                color: '#ff0055',
                fillColor: '#ff0055',
                fillOpacity: 0.1,
                radius: radius,
                weight: 2,
                dashArray: '10, 10'
            }).addTo(this.map);
        }
    }

    drawSafeZone(centerLat, centerLng, radius) {
        if (this.safeZoneCircle) {
            this.safeZoneCircle.setLatLng([centerLat, centerLng]);
            this.safeZoneCircle.setRadius(radius);
        } else {
            this.safeZoneCircle = L.circle([centerLat, centerLng], {
                color: '#00ff9d',
                fillColor: 'transparent',
                radius: radius,
                weight: 2
            }).addTo(this.map);
        }
    }
}
