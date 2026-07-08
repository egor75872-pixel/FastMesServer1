const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { }
    }
    return { users: {}, idIndex: {}, friendRequests: {}, friendships: {}, messages: {} };
}

let data = loadData();
if (!data.idIndex) data.idIndex = {};
if (!data.friendRequests) data.friendRequests = {};
if (!data.friendships) data.friendships = {};
if (!data.messages) data.messages = {};

let saveScheduled = false;
function saveData() {
    if (saveScheduled) return;
    saveScheduled = true;
    setTimeout(() => {
        fs.writeFile(DATA_FILE, JSON.stringify(data), err => { if (err) console.error('Save error:', err); });
        saveScheduled = false;
    }, 200);
}

function pairId(a, b) { return [a, b].sort().join('_'); }

function publicProfile(login) {
    const u = data.users[login];
    if (!u) return null;
    return { login: u.login, id: u.id, name: u.name, online: !!u.online, lastSeen: u.lastSeen };
}

function broadcastPresence(login) {
    Object.values(data.friendships)
        .filter(f => f.members.includes(login))
        .forEach(f => {
            const otherLogin = f.members.find(m => m !== login);
            io.to(otherLogin).emit('presenceUpdate', publicProfile(login));
        });
}

function generateUniqueId() {
    let id;
    do {
        if (Math.random() < 0.0001) {
            const digit = Math.floor(Math.random() * 9) + 1;
            id = String(digit).repeat(7);
        } else {
            id = String(Math.floor(1000000 + Math.random() * 9000000));
        }
    } while (data.idIndex[id]);
    return id;
}

io.on('connection', (socket) => {
    let myLogin = null;

    socket.on('register', ({ name, login, password, hint }, cb) => {
        name = (name || '').trim();
        login = (login || '').trim().toLowerCase();
        hint = (hint || '').trim();

        if (!name || !login || !password || !hint) return cb({ success: false, message: 'Fill all fields!' });
        if (data.users[login]) return cb({ success: false, message: 'Login taken!' });
        if (password.length < 6 || password.length > 30) return cb({ success: false, message: 'Password 6-30 chars!' });
        if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return cb({ success: false, message: 'Need letter + number!' });

        const id = generateUniqueId();
        data.users[login] = { login, id, name, password, hint: hint.toLowerCase(), online: false, lastSeen: Date.now() };
        data.idIndex[id] = login;
        saveData();
        cb({ success: true, id });
    });

    socket.on('login', ({ login, password }, cb) => {
        login = (login || '').trim().toLowerCase();
        const user = data.users[login];
        if (!user || user.password !== password) return cb({ success: false, message: 'Wrong login or password!' });

        myLogin = user.login;
        socket.join(myLogin);
        user.online = true;
        user.lastSeen = Date.now();
        saveData();
        broadcastPresence(myLogin);

        cb({ success: true, name: user.name, id: user.id });
    });

    socket.on('searchUser', (query, cb) => {
        const login = data.idIndex[(query || '').trim()];
        const user = login ? data.users[login] : null;
        if (!user) return cb({ found: false });
        cb({ found: true, login: user.login, id: user.id, name: user.name });
    });

    socket.on('sendFriendRequest', (toLogin) => {
        if (!myLogin || !data.users[toLogin] || toLogin === myLogin) return;
        const reqId = pairId(myLogin, toLogin);
        if (data.friendships[reqId]) return;
        data.friendRequests[reqId] = {
            fromLogin: myLogin, fromName: data.users[myLogin].name,
            toLogin, toName: data.users[toLogin].name, status: 'pending'
        };
        saveData();
        io.to(toLogin).emit('requestsUpdated');
    });

    socket.on('getRequests', (cb) => {
        if (!myLogin) return cb([]);
        const list = Object.entries(data.friendRequests)
            .filter(([, r]) => r.toLogin === myLogin && r.status === 'pending')
            .map(([reqId, r]) => ({ requestId: reqId, ...r }));
        cb(list);
    });

    socket.on('respondRequest', ({ requestId, accepted }) => {
        const req = data.friendRequests[requestId];
        if (!req || req.toLogin !== myLogin) return;

        if (accepted) {
            data.friendships[pairId(req.fromLogin, req.toLogin)] = { members: [req.fromLogin, req.toLogin] };
            req.status = 'accepted';
            io.to(req.fromLogin).emit('friendsUpdated');
            io.to(req.toLogin).emit('friendsUpdated');
        } else {
            req.status = 'declined';
        }
        saveData();
        io.to(myLogin).emit('requestsUpdated');
    });

    socket.on('getFriends', (cb) => {
        if (!myLogin) return cb([]);
        const friendLogins = Object.values(data.friendships)
            .filter(f => f.members.includes(myLogin))
            .map(f => f.members.find(m => m !== myLogin));
        cb(friendLogins.map(publicProfile).filter(Boolean));
    });

    socket.on('getProfile', (login, cb) => cb(publicProfile(login)));

    socket.on('getMessages', (friendLogin, cb) => {
        if (!myLogin) return cb([]);
        const chatId = pairId(myLogin, friendLogin);
        const msgs = data.messages[chatId] || [];
        cb(msgs);
    });

    socket.on('sendMessage', ({ toId, text }) => {
        if (!myLogin || !text || !text.trim() || !data.users[toId]) return;
        const chatId = pairId(myLogin, toId);
        if (!data.messages[chatId]) data.messages[chatId] = [];

        const msg = {
            id: Date.now() + '_' + Math.random().toString(36).slice(2),
            senderId: myLogin, text: text.trim(), status: 'sent', timestamp: Date.now()
        };
        data.messages[chatId].push(msg);
        saveData();

        io.to(toId).emit('newMessage', { chatId, msg });
        io.to(myLogin).emit('newMessage', { chatId, msg });
    });

    socket.on('disconnect', () => {
        if (myLogin && data.users[myLogin]) {
            data.users[myLogin].online = false;
            data.users[myLogin].lastSeen = Date.now();
            saveData();
            broadcastPresence(myLogin);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('FastMes running on port ' + PORT));
