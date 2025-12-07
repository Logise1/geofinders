import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, remove, onDisconnect, get } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-database.js";
import { firebaseConfig } from "./config.js";
import { MapManager } from "./map.js";
import { GameManager } from "./game.js";
import { generateId } from "./utils.js";

// --- INITIALIZATION ---
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// State
let userId = localStorage.getItem('geofinder_uid') || generateId();
localStorage.setItem('geofinder_uid', userId);

let playerName = "Agent";
let gameMode = "solo";
let activeTab = "create";
let roomId = "main_game"; // Default placeholder, will be overwritten
let duoCode = "";
let isGameActive = false;
let currentLat = 0;
let currentLng = 0;
let scatterTimerInterval = null;

// Managers
const mapManager = new MapManager();
let gameManager = null;

// DOM Elements
const lobbyScreen = document.getElementById('lobby-screen');
const gameHud = document.getElementById('game-hud');
const combatOverlay = document.getElementById('combat-overlay');
const scatterOverlay = document.getElementById('scatter-overlay');
const scatterTimerEl = document.getElementById('scatter-timer');
const gameCodeInput = document.getElementById('game-code-input');

// --- EVENT LISTENERS (Bridged from HTML) ---
window.addEventListener('switchTab', (e) => {
    activeTab = e.detail;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick="switchTab('${activeTab}')"]`).classList.add('active');

    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${activeTab}`).classList.add('active');

    const btnText = document.getElementById('start-btn-text');
    btnText.innerText = activeTab === 'create' ? 'CREAR OPERACIÓN' : 'UNIRSE A OPERACIÓN';
});

window.addEventListener('selectMode', (e) => {
    gameMode = e.detail;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('selected'));
    document.querySelector(`.mode-btn[data-mode="${gameMode}"]`).classList.add('selected');

    const duoSection = document.getElementById('duo-code-section');
    if (gameMode === 'duo') duoSection.classList.remove('hidden');
    else duoSection.classList.add('hidden');
});

window.addEventListener('handleGameStart', async () => {
    const nameInput = document.getElementById('player-name').value;
    if (!nameInput) {
        alert("¡INGRESA TU NOMBRE DE AGENTE!");
        return;
    }
    playerName = nameInput;

    if (activeTab === 'create') {
        // Generate new Room ID (4 chars)
        roomId = generateId().substring(0, 4).toUpperCase();
        await createGameRoom(roomId);
    } else {
        // Join existing Room
        roomId = gameCodeInput.value.trim().toUpperCase();
        if (!roomId) {
            alert("¡INGRESA EL CÓDIGO DE PARTIDA!");
            return;
        }
        // Verify room exists
        const snapshot = await get(ref(db, `games/${roomId}`));
        if (!snapshot.exists()) {
            alert("¡LA PARTIDA NO EXISTE!");
            return;
        }
    }

    if (gameMode === 'duo') {
        duoCode = document.getElementById('duo-code').value || generateId();
    }

    enterGame();
});

window.addEventListener('toggleCombatMode', () => {
    combatOverlay.classList.toggle('hidden');
    document.getElementById('crosshair').classList.toggle('hidden');
});

window.addEventListener('fireWeapon', () => {
    if (gameManager) {
        gameManager.shoot(currentLat, currentLng, latestPlayersState);
    }
});

window.addEventListener('triggerSOS', () => {
    if (confirm("¿ACTIVAR SOS? ESTO TE ELIMINARÁ DE LA PARTIDA.")) {
        const sosRef = ref(db, `games/${roomId}/sos/${userId}`);
        set(sosRef, {
            lat: currentLat,
            lng: currentLng,
            name: playerName,
            time: Date.now()
        });
        if (gameManager) gameManager.die();
    }
});

// --- CORE LOGIC ---

let latestPlayersState = {};

async function createGameRoom(newRoomId) {
    // Initialize default game state
    await set(ref(db, `games/${newRoomId}/state`), {
        phase: 'scatter', // scatter, active, ended
        startTime: Date.now() + 120000, // 2 minutes from now
        revealAll: false,
        createdBy: userId
    });
}

function enterGame() {
    lobbyScreen.classList.remove('active');
    lobbyScreen.classList.add('hidden');

    // Check geolocation before showing HUD
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(onLocationUpdate, onLocationError, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 5000
        });
    } else {
        alert("Geolocation not supported.");
    }

    // Init tracking
    initDeviceOrientation();

    // Register Player
    const playerRef = ref(db, `games/${roomId}/players/${userId}`);
    set(playerRef, {
        name: playerName,
        mode: gameMode,
        teamId: duoCode,
        hp: 100,
        lat: 0,
        lng: 0,
        dead: false,
        lastActive: Date.now()
    });
    onDisconnect(playerRef).remove();

    // Listeners
    setupGameListeners();
}

function setupGameListeners() {
    // 1. Game State (Phases)
    const stateRef = ref(db, `games/${roomId}/state`);
    onValue(stateRef, (snapshot) => {
        const state = snapshot.val();
        if (!state) return;

        handleGamePhase(state);
    });

    // 2. Players
    const playersRef = ref(db, `games/${roomId}/players`);
    onValue(playersRef, (snapshot) => {
        const players = snapshot.val() || {};
        latestPlayersState = players;
        mapManager.updateOtherPlayers(players, userId);

        const aliveCount = Object.values(players).filter(p => !p.dead).length;
        document.getElementById('alive-count').innerText = aliveCount;

        if (players[userId] && players[userId].incoming_hits) {
            processHits(players[userId].incoming_hits);
        }
    });

    // 3. Storm
    const stormRef = ref(db, `games/${roomId}/storm`);
    onValue(stormRef, (snapshot) => {
        const storm = snapshot.val();
        if (storm) {
            mapManager.drawStorm(storm.lat, storm.lng, storm.radius);
            mapManager.drawSafeZone(storm.safeLat, storm.safeLng, storm.safeRadius);
            if (gameManager && isGameActive) {
                gameManager.checkStorm(currentLat, currentLng, {
                    lat: storm.safeLat, lng: storm.safeLng, radius: storm.safeRadius
                });
            }
        }
    });
}

function handleGamePhase(state) {
    const { phase, startTime } = state;

    // Scatter Phase Handling
    if (phase === 'scatter') {
        const now = Date.now();
        const timeLeft = Math.max(0, startTime - now);

        if (timeLeft > 0) {
            // Show Scatter UI
            scatterOverlay.classList.remove('hidden');
            gameHud.classList.add('hidden'); // Hide HUD during scatter
            updateScatterTimer(timeLeft);

            if (!scatterTimerInterval) {
                scatterTimerInterval = setInterval(() => {
                    const remaining = startTime - Date.now();
                    if (remaining <= 0) {
                        clearInterval(scatterTimerInterval);
                        scatterTimerInterval = null;
                        // Time is up, wait for server/admin to switch or switch locally if host? 
                        // For simplicity, local switch if time passed
                    }
                    updateScatterTimer(Math.max(0, remaining));
                }, 1000);
            }
        } else {
            // Timer finished
            scatterOverlay.classList.add('hidden');
            gameHud.classList.remove('hidden');
            gameHud.classList.add('active');
            isGameActive = true;

            // Should verify if we need to Initialize GameManager
            if (!gameManager) gameManager = new GameManager(userId, gameMode, db);
        }
    } else if (phase === 'active') {
        scatterOverlay.classList.add('hidden');
        if (scatterTimerInterval) clearInterval(scatterTimerInterval);

        gameHud.classList.remove('hidden');
        gameHud.classList.add('active');
        isGameActive = true;
        if (!gameManager) gameManager = new GameManager(userId, gameMode, db);
    }
}

function updateScatterTimer(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    scatterTimerEl.innerText = `${minutes}:${seconds}`;
}


function onLocationUpdate(position) {
    const { latitude, longitude } = position.coords;
    currentLat = latitude;
    currentLng = longitude;

    if (!mapManager.map) {
        mapManager.init(latitude, longitude);
    }

    mapManager.updateUserPosition(latitude, longitude);

    // Always update location in DB (even during scatter)
    update(ref(db, `games/${roomId}/players/${userId}`), {
        lat: latitude,
        lng: longitude,
        lastActive: Date.now()
    });
}

function onLocationError(error) {
    console.error("Location error:", error);
}

function initDeviceOrientation() {
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (event) => {
            let heading = event.alpha;
            if (event.webkitCompassHeading) heading = event.webkitCompassHeading;
            if (heading != null && gameManager) gameManager.setHeading(heading);
        }, true);
    }
}

function processHits(hits) {
    Object.entries(hits).forEach(([key, hit]) => {
        gameManager.takeDamage(hit.amount, hit.shooter);
        remove(ref(db, `games/${roomId}/players/${userId}/incoming_hits/${key}`));
    });
}
