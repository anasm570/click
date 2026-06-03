const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// ---------- تخزين مؤقت في الذاكرة (لبيئة Serverless) ----------
let users = {};        // key "name|phone" -> { name, phone, score, speed, friends }
let players = {};     // socket.id -> بيانات اللاعب في اللعبة
let grid = Array(30).fill().map(() => Array(30).fill(null));

// ---------- API المصادقة (بدون كتابة ملفات) ----------
app.post('/api/login', (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'الاسم ورقم الهاتف مطلوبان' });
    const key = `${name}|${phone}`;
    let user = users[key];
    if (!user) {
        user = { name, phone, score: 0, speed: 1, friends: [] };
        users[key] = user;
    }
    res.json({ success: true, userData: { name, phone, score: user.score, speed: user.speed, friends: user.friends } });
});

app.post('/api/update-score', (req, res) => {
    const { key, score, speed } = req.body;
    if (users[key]) {
        users[key].score = score;
        users[key].speed = speed;
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'مستخدم غير موجود' });
    }
});

// ---------- منطق اللعبة ----------
const MAP_W = 30, MAP_H = 30;
const DIRECTIONS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

function getRandomEmptyCell() {
    for (let i = 0; i < 200; i++) {
        let x = Math.floor(Math.random() * MAP_W);
        let y = Math.floor(Math.random() * MAP_H);
        if (grid[x][y] === null) return { x, y };
    }
    return { x: 5, y: 5 };
}

function addPlayer(socketId, name, speed = 1) {
    let start = getRandomEmptyCell();
    players[socketId] = {
        id: socketId,
        name,
        x: start.x,
        y: start.y,
        direction: 'right',
        trail: [],
        territory: [{ x: start.x, y: start.y }],
        score: 0,
        speed,
        color: `hsl(${Math.random() * 360}, 70%, 55%)`,
        active: true
    };
    grid[start.x][start.y] = socketId;
    return players[socketId];
}

function removePlayer(socketId) {
    if (players[socketId]) {
        for (let tile of players[socketId].territory) {
            if (grid[tile.x] && grid[tile.x][tile.y] === socketId) grid[tile.x][tile.y] = null;
        }
        delete players[socketId];
    }
}

io.on('connection', (socket) => {
    let currentUserKey = null;

    socket.on('login', ({ name, phone }) => {
        currentUserKey = `${name}|${phone}`;
        let user = users[currentUserKey] || { score: 0, speed: 1 };
        let newPlayer = addPlayer(socket.id, name, user.speed);
        newPlayer.score = user.score;
        socket.emit('init', {
            player: { id: socket.id, x: newPlayer.x, y: newPlayer.y, color: newPlayer.color, score: newPlayer.score, speed: newPlayer.speed },
            map: grid,
            players: Object.keys(players).map(id => ({
                id, name: players[id].name, x: players[id].x, y: players[id].y,
                color: players[id].color, score: players[id].score
            }))
        });
        socket.broadcast.emit('player-joined', { id: socket.id, name, x: newPlayer.x, y: newPlayer.y, color: newPlayer.color });
    });

    socket.on('move', (dir) => {
        let p = players[socket.id];
        if (!p || !p.active) return;
        if ((dir === 'right' && p.direction === 'left') ||
            (dir === 'left' && p.direction === 'right') ||
            (dir === 'up' && p.direction === 'down') ||
            (dir === 'down' && p.direction === 'up')) return;
        p.direction = dir;
    });

    socket.on('disconnect', () => {
        removePlayer(socket.id);
        io.emit('player-left', socket.id);
    });
});

// حلقة اللعبة (كل 100 مللي ثانية)
setInterval(() => {
    for (let id in players) {
        let p = players[id];
        if (!p.active) continue;
        let step = p.speed;
        let dir = DIRECTIONS[p.direction];
        if (!dir) continue;
        let newX = p.x + dir.x;
        let newY = p.y + dir.y;

        // حدود اللوحة
        if (newX < 0 || newX >= MAP_W || newY < 0 || newY >= MAP_H) {
            p.active = false;
            io.to(id).emit('game-over', { score: p.score });
            setTimeout(() => {
                if (players[id]) {
                    let start = getRandomEmptyCell();
                    p.x = start.x;
                    p.y = start.y;
                    p.direction = 'right';
                    p.trail = [];
                    p.territory = [{ x: start.x, y: start.y }];
                    p.active = true;
                    grid[start.x][start.y] = id;
                    io.to(id).emit('respawn', { x: start.x, y: start.y });
                }
            }, 2000);
            continue;
        }

        let owner = grid[newX][newY];
        if (owner === id || owner === null) {
            p.x = newX;
            p.y = newY;
            if (owner !== id) {
                p.trail.push({ x: newX, y: newY });
                grid[newX][newY] = id;
            } else {
                if (p.trail.length > 0) {
                    let newCells = [...p.trail, { x: newX, y: newY }];
                    for (let cell of newCells) {
                        if (!p.territory.some(t => t.x === cell.x && t.y === cell.y)) {
                            p.territory.push(cell);
                            p.score += 5;
                        }
                        grid[cell.x][cell.y] = id;
                    }
                    p.trail = [];
                }
            }
            io.emit('player-move', { id, x: p.x, y: p.y, direction: p.direction, trail: p.trail });
        } else {
            // اصطدام بلاعب آخر
            p.active = false;
            io.to(id).emit('game-over', { score: p.score });
            setTimeout(() => {
                if (players[id]) {
                    let start = getRandomEmptyCell();
                    p.x = start.x;
                    p.y = start.y;
                    p.direction = 'right';
                    p.trail = [];
                    p.territory = [{ x: start.x, y: start.y }];
                    p.active = true;
                    grid[start.x][start.y] = id;
                    io.to(id).emit('respawn', { x: start.x, y: start.y });
                }
            }, 2000);
        }
    }
}, 100);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => console.log(`✅ Paper.io 2 يعمل على http://localhost:${PORT}`));