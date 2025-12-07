import { getDistance, getBearing } from './utils.js';

export class GameManager {
    constructor(userId, mode, firebaseRef) {
        this.userId = userId;
        this.mode = mode;
        this.db = firebaseRef;
        this.hp = 100;
        this.shield = 0;
        this.ammo = 10;
        this.isDead = false;
        this.lastShot = 0;
        this.compassHeading = 0;

        // Settings
        this.maxHp = 100;
        this.stormDamage = 5;
        this.stormInterval = 5000; // 5s
        this.lastStormTick = 0;
    }

    updateStats(hp, shield) {
        this.hp = hp;
        this.shield = shield;
        // Update UI
        document.getElementById('health-bar').style.width = `${this.hp}%`;
        document.getElementById('shield-bar').style.width = `${this.shield}%`;

        if (this.hp <= 0 && !this.isDead) {
            this.die();
        }
    }

    setHeading(heading) {
        this.compassHeading = heading;
        // Update Compass UI
        const arrow = document.getElementById('compass-arrow');
        const ticks = document.querySelector('.compass-ticks');
        if (arrow) arrow.style.transform = `translateX(-50%) rotate(${heading}deg)`;
        // In a real app, we'd scroll the ticks, but rotating the arrow is a simple visual cue for now
    }

    checkStorm(userLat, userLng, safeZone) {
        if (!safeZone) return;

        const dist = getDistance(userLat, userLng, safeZone.lat, safeZone.lng);
        if (dist > safeZone.radius) {
            const now = Date.now();
            if (now - this.lastStormTick > this.stormInterval) {
                this.takeDamage(this.stormDamage, "TORMENTA");
                this.lastStormTick = now;
                this.showNotification("¡ESTÁS EN LA TORMENTA!", "danger");
            }
        }
    }

    checkDuoDistance(userLat, userLng, partnerLat, partnerLng) {
        if (this.mode !== 'duo' || !partnerLat) return;

        const dist = getDistance(userLat, userLng, partnerLat, partnerLng);
        if (dist > 15) {
            this.showNotification(`¡PAREJA MUY LEJOS! (${Math.round(dist)}m)`, "warning");
            // Logic for countdown/damage could go here
        }
    }

    shoot(userLat, userLng, players) {
        const now = Date.now();
        if (now - this.lastShot < 1000) return; // Cooldown
        this.lastShot = now;

        let hit = false;

        Object.entries(players).forEach(([id, p]) => {
            if (id === this.userId || p.dead) return;
            if (this.mode === 'duo' && p.teamId === this.myTeamId) return; // Don't shoot partner

            const dist = getDistance(userLat, userLng, p.lat, p.lng);
            if (dist < 50) { // Range 50m
                const bearingToTarget = getBearing(userLat, userLng, p.lat, p.lng);
                const angleDiff = Math.abs(bearingToTarget - this.compassHeading);

                // 15 degree cone
                if (angleDiff < 15 || angleDiff > 345) {
                    // HIT!
                    this.dealDamage(id, 20); // 20 dmg
                    this.showNotification(`¡IMPACTO A ${p.name}!`, "success");
                    hit = true;
                }
            }
        });

        if (!hit) {
            this.showNotification("FALLASTE", "normal");
        }
    }

    takeDamage(amount, source) {
        let newHp = this.hp - amount;
        if (newHp < 0) newHp = 0;

        // Update local state immediately for responsiveness, then sync
        this.updateStats(newHp, this.shield);

        // Sync to Firebase
        // Note: In a secure app, damage should be server-side or verified. 
        // Here we trust the client for simplicity.
        // We will emit an event that App.js listens to to update Firebase
        window.dispatchEvent(new CustomEvent('playerDamaged', { detail: { newHp, source } }));
    }

    dealDamage(targetId, amount) {
        window.dispatchEvent(new CustomEvent('dealDamage', { detail: { targetId, amount } }));
    }

    die() {
        this.isDead = true;
        document.getElementById('death-screen').classList.remove('hidden');
        document.getElementById('death-screen').classList.add('active');
    }

    showNotification(msg, type) {
        const area = document.getElementById('notification-area');
        const notif = document.createElement('div');
        notif.className = `notification ${type}`;
        notif.innerText = msg;
        area.appendChild(notif);
        setTimeout(() => notif.remove(), 3000);
    }
}
