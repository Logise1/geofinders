import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, remove, onDisconnect } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-database.js";
import { firebaseConfig } from "./config.js";
import { MapManager } from "./map.js";
import { GameManager } from "./game.js";
import { generateId, getRandomPosition } from "./utils.js";

// --- INITIALIZATION ---
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// State
let userId = localStorage.getItem('geofinder_uid') || generateId();
localStorage.setItem('geofinder_uid', userId);

let playerName = "Agent";
let gameMode = "solo";
let duoCode = "";
let isGameActive = false;
let currentLat = 0;
let currentLng = 0;

// Managers
const mapManager = new MapManager();
let gameManager = null;

// DOM Elements
const lobbyScreen = document.getElementById('lobby-screen');
const gameHud = document.getElementById('game-hud');
const combatOverlay = document.getElementById('combat-overlay');

// --- EVENT LISTENERS (Bridged from HTML) ---
window.addEventListener('selectMode', (e) => {
    gameMode = e.detail;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('selected'));
    document.querySelector(`.mode-btn[data-mode="${gameMode}"]`).classList.add('selected');

    const duoSection = document.getElementById('duo-code-section');
    if (gameMode === 'duo') duoSection.classList.remove('hidden');
    else duoSection.classList.add('hidden');
});

window.addEventListener('startGame', () => {
    const nameInput = document.getElementById('player-name').value;
    if (nameInput) playerName = nameInput;

    if (gameMode === 'duo') {
        duoCode = document.getElementById('duo-code').value || generateId(); // Generate if empty
    }

    enterGame();
});

window.addEventListener('toggleCombatMode', () => {
    combatOverlay.classList.toggle('hidden');
    document.getElementById('crosshair').classList.toggle('hidden');
});

window.addEventListener('fireWeapon', () => {
    if (gameManager) {
        // We need the list of players to check hits. 
        // We'll store the latest players state in a variable accessible here.
        gameManager.shoot(currentLat, currentLng, latestPlayersState);
    }
});

window.addEventListener('triggerSOS', () => {
    if (confirm("¿ACTIVAR SOS? ESTO TE ELIMINARÁ DE LA PARTIDA.")) {
        // Send SOS to DB
        const sosRef = ref(db, `games/main_game/sos/${userId}`);
        set(sosRef, {
            lat: currentLat,
            lng: currentLng,
            name: playerName,
            time: Date.now()
        });

        // Kill player
        if (gameManager) gameManager.die();
    }
});

window.addEventListener('playerDamaged', (e) => {
    const { newHp, source } = e.detail;
    update(ref(db, `games/main_game/players/${userId}`), {
        hp: newHp
    });
});

window.addEventListener('dealDamage', (e) => {
    const { targetId, amount } = e.detail;
    // Transactionally update target HP would be better, but simple update for now
    // We can't easily read-modify-write another player's node without a transaction or cloud function
    // For this prototype, we'll write to a 'damage_queue' and let clients process it?
    // OR: Just trust the shooter to update the target (Insecure but easiest for prototype)

    // Better approach for Client-side only:
    // Write a 'hit' event to the target's node
    const hitRef = ref(db, `games/main_game/players/${targetId}/incoming_hits/${Date.now()}`);
    set(hitRef, { amount: amount, shooter: playerName });
});

// --- CORE LOGIC ---

let latestPlayersState = {};

function enterGame() {
    lobbyScreen.classList.remove('active');
    lobbyScreen.classList.add('hidden');
    gameHud.classList.remove('hidden');
    gameHud.classList.add('active');

    isGameActive = true;

    // Init Game Manager
    gameManager = new GameManager(userId, gameMode, db);

    // Start Location Tracking
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(onLocationUpdate, onLocationError, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 5000
        });
    } else {
        alert("Geolocation is not supported by this browser.");
    }

    // Start Compass Tracking
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (event) => {
            let heading = event.alpha; // Z-axis rotation

            // iOS webkitCompassHeading support
            if (event.webkitCompassHeading) {
                heading = event.webkitCompassHeading;
            }

            if (heading != null && gameManager) {
                gameManager.setHeading(heading);
            }
        }, true);
    }

    // Register Player in DB
    const playerRef = ref(db, `games/main_game/players/${userId}`);
    set(playerRef, {
        name: playerName,
        mode: gameMode,
        teamId: duoCode,
        hp: 100,
        lat: 0, // Will update on first fix
        lng: 0,
        dead: false,
        lastActive: Date.now()
    });

    // Remove on disconnect
    onDisconnect(playerRef).remove();

    // Listen for Game State (Global)
    const stateRef = ref(db, `games/main_game/state`);
    onValue(stateRef, (snapshot) => {
        const state = snapshot.val();
        if (state && state.revealAll) {
            mapManager.forceShowAll = true;
            document.getElementById('notification-area').innerHTML = '<div class="notification warning">¡UBICACIONES REVELADAS!</div>';
        } else {
            mapManager.forceShowAll = false;
        }
        // Re-render markers if we have player data
        if (latestPlayersState) {
            mapManager.updateOtherPlayers(latestPlayersState, userId);
        }
    });

    // Listen for Players
    const playersRef = ref(db, `games/main_game/players`);
    onValue(playersRef, (snapshot) => {
        const players = snapshot.val() || {};
        latestPlayersState = players;

        // Update Map
        mapManager.updateOtherPlayers(players, userId);

        // Update Alive Count
        const aliveCount = Object.values(players).filter(p => !p.dead).length;
        document.getElementById('alive-count').innerText = aliveCount;

        // Check for incoming hits
        if (players[userId] && players[userId].incoming_hits) {
            processHits(players[userId].incoming_hits);
        }
    });

    // Listen for Storm
    const stormRef = ref(db, `games/main_game/storm`);
    onValue(stormRef, (snapshot) => {
        const storm = snapshot.val();
        if (storm) {
            mapManager.drawStorm(storm.lat, storm.lng, storm.radius);
            mapManager.drawSafeZone(storm.safeLat, storm.safeLng, storm.safeRadius);

            if (gameManager) {
                gameManager.checkStorm(currentLat, currentLng, {
                    lat: storm.safeLat,
                    lng: storm.safeLng,
                    radius: storm.safeRadius
                });
            }
        }
    });
}

function onLocationUpdate(position) {
    const { latitude, longitude } = position.coords;
    currentLat = latitude;
    currentLng = longitude;

    // Init map on first fix
    if (!mapManager.map) {
        mapManager.init(latitude, longitude);
    }

    mapManager.updateUserPosition(latitude, longitude);

    // Update DB
    if (isGameActive) {
        update(ref(db, `games/main_game/players/${userId}`), {
            lat: latitude,
            lng: longitude,
            lastActive: Date.now()
        });
    }

    // Check Duo Distance
    if (gameMode === 'duo' && latestPlayersState) {
        // Find partner
        const partner = Object.values(latestPlayersState).find(p => p.teamId === duoCode && p.name !== playerName);
        if (partner) {
            gameManager.checkDuoDistance(latitude, longitude, partner.lat, partner.lng);
        }
    }
}

function onLocationError(error) {
    console.error("Location error:", error);
    // In a real app, show a UI warning
}

function processHits(hits) {
    // hits is an object of timestamp -> {amount, shooter}
    Object.entries(hits).forEach(([key, hit]) => {
        gameManager.takeDamage(hit.amount, hit.shooter);
        // Remove processed hit
        remove(ref(db, `games/main_game/players/${userId}/incoming_hits/${key}`));
    });
}

// --- ADMIN / HOST FUNCTIONS (Auto-run for demo) ---
// In a real app, this would be a separate admin panel.
// Here we'll just init the storm if it doesn't exist.
const stormRef = ref(db, `games/main_game/storm`);
onValue(stormRef, (snapshot) => {
    if (!snapshot.exists()) {
        // Create initial storm
        // We need a center. For demo, we'll wait for the first player's location or default.
        // Skipping for now to avoid overwriting if an admin is already running.
    }
});
