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

// إعداد الجلسات
app.use(session({
    secret: 'planet-clicker-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // اضبط true إذا كان الموقع على HTTPS
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); // خدمة الملفات من الجذر

// ------------------- ملف تخزين المستخدمين -------------------
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

// ------------------- API للمصادقة -------------------
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    let users = loadUsers();
    if (users[username]) return res.status(400).json({ error: 'اسم المستخدم موجود' });
    users[username] = {
        password,
        coins: 0,
        clickPower: 1,
        autoClicker: 0,
        friends: [],
        createdAt: new Date().toISOString()
    };
    saveUsers(users);
    res.json({ success: true, message: 'تم التسجيل بنجاح' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    let users = loadUsers();
    if (users[username] && users[username].password === password) {
        req.session.user = username;
        res.json({ success: true, message: `مرحباً ${username}` });
    } else {
        res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
});

app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'غير مسجل' });
    let users = loadUsers();
    let user = users[req.session.user];
    if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({
        username: req.session.user,
        coins: user.coins,
        clickPower: user.clickPower,
        autoClicker: user.autoClicker,
        friends: user.friends
    });
});

app.get('/api/user/:username', (req, res) => {
    let users = loadUsers();
    let user = users[req.params.username];
    if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({ username: req.params.username, coins: user.coins });
});

app.post('/api/add-friend', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'غير مسجل' });
    let { friendName } = req.body;
    if (friendName === req.session.user) return res.status(400).json({ error: 'لا يمكن إضافة نفسك' });
    let users = loadUsers();
    if (!users[friendName]) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (users[req.session.user].friends.includes(friendName)) return res.status(400).json({ error: 'الصديق موجود بالفعل' });
    users[req.session.user].friends.push(friendName);
    saveUsers(users);
    res.json({ success: true, friends: users[req.session.user].friends });
});

// ------------------- Socket.IO للأحداث الفورية -------------------
io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('user-login', (username) => {
        currentUser = username;
        socket.join(`user:${username}`);
        // إرسال بيانات المستخدم الحالية
        let users = loadUsers();
        let user = users[username];
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
        if (!currentUser) return;
        let users = loadUsers();
        let user = users[currentUser];
        if (!user) return;
        user.coins += user.clickPower;
        saveUsers(users);
        io.to(`user:${currentUser}`).emit('coins-update', { coins: user.coins });
    });

    socket.on('buy-upgrade', ({ type }) => {
        if (!currentUser) return;
        let users = loadUsers();
        let user = users[currentUser];
        if (!user) return;
        let cost = 0;
        if (type === 'clickPower') {
            cost = 50 + (user.clickPower - 1) * 30;
            if (user.coins >= cost) {
                user.coins -= cost;
                user.clickPower++;
                saveUsers(users);
                io.to(`user:${currentUser}`).emit('upgrade-bought', { type, newValue: user.clickPower, coins: user.coins });
            } else socket.emit('error', 'نقود غير كافية');
        } else if (type === 'autoClicker') {
            cost = 200 + (user.autoClicker) * 100;
            if (user.coins >= cost) {
                user.coins -= cost;
                user.autoClicker++;
                saveUsers(users);
                io.to(`user:${currentUser}`).emit('upgrade-bought', { type, newValue: user.autoClicker, coins: user.coins });
            } else socket.emit('error', 'نقود غير كافية');
        }
    });

    socket.on('send-coins', ({ to, amount }) => {
        if (!currentUser) return;
        if (to === currentUser) return socket.emit('error', 'لا يمكن إرسال نقود لنفسك');
        let users = loadUsers();
        let sender = users[currentUser];
        let receiver = users[to];
        if (!sender || !receiver) return socket.emit('error', 'مستخدم غير موجود');
        if (sender.coins < amount) return socket.emit('error', 'نقود غير كافية');
        if (amount <= 0) return socket.emit('error', 'المبلغ يجب أن يكون أكبر من 0');
        sender.coins -= amount;
        receiver.coins += amount;
        saveUsers(users);
        io.to(`user:${currentUser}`).emit('coins-update', { coins: sender.coins });
        io.to(`user:${to}`).emit('coins-update', { coins: receiver.coins });
        io.to(`user:${to}`).emit('received-coins', { from: currentUser, amount });
        socket.emit('coins-sent', { to, amount });
    });

    socket.on('disconnect', () => {});
});

// ------------------- تقديم الصفحة الرئيسية -------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
    console.log(`✅ Planet Clicker يعمل على http://localhost:${PORT}`);
});