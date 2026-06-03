const express = require('express');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

app.use(session({
    secret: 'planet-clicker-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ------------------- ملف تخزين البيانات -------------------
const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE));
    } catch(e) { return {}; }
}
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ------------------- API: تسجيل الدخول / إنشاء حساب بالاسم ورقم الهاتف -------------------
app.post('/api/login', (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'الاسم ورقم الهاتف مطلوبان' });
    let users = loadUsers();
    const key = `${name}|${phone}`;
    let user = users[key];
    if (!user) {
        // إنشاء مستخدم جديد
        user = {
            name,
            phone,
            coins: 0,
            clickPower: 1,
            autoClicker: 0,
            friends: [],
            createdAt: new Date().toISOString()
        };
        users[key] = user;
        saveUsers(users);
    }
    req.session.userKey = key;
    req.session.userName = name;
    res.json({ success: true, message: `مرحباً ${name}`, userData: {
        name, phone,
        coins: user.coins,
        clickPower: user.clickPower,
        autoClicker: user.autoClicker,
        friends: user.friends
    } });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userKey) return res.status(401).json({ error: 'غير مسجل' });
    let users = loadUsers();
    let user = users[req.session.userKey];
    if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({
        name: user.name,
        phone: user.phone,
        coins: user.coins,
        clickPower: user.clickPower,
        autoClicker: user.autoClicker,
        friends: user.friends
    });
});

app.post('/api/add-friend', (req, res) => {
    if (!req.session.userKey) return res.status(401).json({ error: 'غير مسجل' });
    let { friendName } = req.body;
    if (friendName === req.session.userName) return res.status(400).json({ error: 'لا يمكن إضافة نفسك' });
    let users = loadUsers();
    let friendKey = null;
    for (let k in users) {
        if (users[k].name === friendName) {
            friendKey = k;
            break;
        }
    }
    if (!friendKey) return res.status(404).json({ error: 'المستخدم غير موجود' });
    let currentUser = users[req.session.userKey];
    if (currentUser.friends.includes(friendName)) return res.status(400).json({ error: 'الصديق موجود بالفعل' });
    currentUser.friends.push(friendName);
    saveUsers(users);
    res.json({ success: true, friends: currentUser.friends });
});

// ------------------- Socket.IO -------------------
io.on('connection', (socket) => {
    let currentUserKey = null;

    socket.on('user-login', (userKey) => {
        currentUserKey = userKey;
        socket.join(`user:${userKey}`);
        let users = loadUsers();
        let user = users[userKey];
        if (user) {
            socket.emit('init-data', {
                coins: user.coins,
                clickPower: user.clickPower,
                autoClicker: user.autoClicker,
                friends: user.friends
            });
        }
    });

    socket.on('click-planet', () => {
        if (!currentUserKey) return;
        let users = loadUsers();
        let user = users[currentUserKey];
        if (!user) return;
        user.coins += user.clickPower;
        saveUsers(users);
        io.to(`user:${currentUserKey}`).emit('coins-update', { coins: user.coins });
    });

    socket.on('buy-upgrade', ({ type }) => {
        if (!currentUserKey) return;
        let users = loadUsers();
        let user = users[currentUserKey];
        if (!user) return;
        let cost = 0;
        if (type === 'clickPower') {
            cost = 50 + (user.clickPower - 1) * 30;
            if (user.coins >= cost) {
                user.coins -= cost;
                user.clickPower++;
                saveUsers(users);
                io.to(`user:${currentUserKey}`).emit('upgrade-bought', { type, newValue: user.clickPower, coins: user.coins });
            } else socket.emit('error', 'نقود غير كافية');
        } else if (type === 'autoClicker') {
            cost = 200 + (user.autoClicker) * 100;
            if (user.coins >= cost) {
                user.coins -= cost;
                user.autoClicker++;
                saveUsers(users);
                io.to(`user:${currentUserKey}`).emit('upgrade-bought', { type, newValue: user.autoClicker, coins: user.coins });
            } else socket.emit('error', 'نقود غير كافية');
        }
    });

    socket.on('send-coins', ({ toName, amount }) => {
        if (!currentUserKey) return;
        if (toName === users[currentUserKey]?.name) return socket.emit('error', 'لا يمكن إرسال نقود لنفسك');
        let users = loadUsers();
        let sender = users[currentUserKey];
        if (!sender) return;
        let receiverKey = null;
        for (let k in users) {
            if (users[k].name === toName) {
                receiverKey = k;
                break;
            }
        }
        if (!receiverKey) return socket.emit('error', 'المستخدم غير موجود');
        let receiver = users[receiverKey];
        if (sender.coins < amount) return socket.emit('error', 'نقود غير كافية');
        if (amount <= 0) return socket.emit('error', 'المبلغ يجب أن يكون أكبر من 0');
        sender.coins -= amount;
        receiver.coins += amount;
        saveUsers(users);
        io.to(`user:${currentUserKey}`).emit('coins-update', { coins: sender.coins });
        io.to(`user:${receiverKey}`).emit('coins-update', { coins: receiver.coins });
        io.to(`user:${receiverKey}`).emit('received-coins', { from: sender.name, amount });
        socket.emit('coins-sent', { to: toName, amount });
    });
});

// ------------------- الصفحة الرئيسية -------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
    console.log(`✅ Planet Clicker يعمل على http://localhost:${PORT}`);
});