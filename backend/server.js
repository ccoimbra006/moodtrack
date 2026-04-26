require('dotenv').config();

console.log("CLIENT_ID:", process.env.SPOTIFY_CLIENT_ID);

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configurações Spotify
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://127.0.0.1:3001/callback';
const PORT = process.env.PORT || 3001;

// Armazenamento em memória (em produção use Redis/DB)
let accessToken = null;
let refreshToken = null;
let tokenExpiry = null;

// Arquivo para persistir dados (comentários e curtidas)
const DATA_FILE = path.join(__dirname, 'music-data.json');

// Estrutura: { comments: { trackId: [...] }, likes: { trackId: [userId1, userId2, ...] } }
function readData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Erro ao ler dados:', e);
    }
    return { comments: {}, likes: {} };
}

function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Erro ao salvar dados:', e);
    }
}

// ============================================
// ROTAS DE AUTENTICAÇÃO OAUTH
// ============================================

// 1. Login - Redireciona para Spotify
app.get('/login', (req, res) => {
    const scope = [
        'streaming',
        'user-read-email',
        'user-read-private',
        'user-read-playback-state',
        'user-modify-playback-state',
        'user-read-currently-playing',
        'app-remote-control'
    ].join(' ');

    const authUrl = 'https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: CLIENT_ID,
            scope: scope,
            redirect_uri: REDIRECT_URI,
            show_dialog: true
        });

    res.redirect(authUrl);
});

// 2. Callback - Spotify retorna aqui
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;

    if (!code) {
        return res.status(400).json({ error: 'Código de autorização não fornecido' });
    }

    try {
        const response = await axios.post(
            'https://accounts.spotify.com/api/token',
            querystring.stringify({
                code: code,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code'
            }),
            {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;
        tokenExpiry = Date.now() + (response.data.expires_in * 1000);

        console.log('✅ Autenticado com sucesso!');
        console.log('Token expira em:', new Date(tokenExpiry));

        // Redireciona de volta para o frontend
        res.redirect(process.env.FRONTEND_URL + '?auth=success');

    } catch (error) {
        console.error('Erro na autenticação:', error.response?.data || error.message);
        res.status(500).json({ error: 'Falha na autenticação' });
    }
});

// 3. Refresh token automático
async function refreshAccessToken() {
    if (!refreshToken) {
        throw new Error('Nenhum refresh token disponível');
    }

    try {
        const response = await axios.post(
            'https://accounts.spotify.com/api/token',
            querystring.stringify({
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            }),
            {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        accessToken = response.data.access_token;
        tokenExpiry = Date.now() + (response.data.expires_in * 1000);

        console.log('🔄 Token atualizado');
        return accessToken;

    } catch (error) {
        console.error('Erro ao refresh token:', error.response?.data || error.message);
        throw error;
    }
}

// Middleware para garantir token válido
async function ensureValidToken(req, res, next) {
    try {
        if (!accessToken) {
            return res.status(401).json({
                error: 'Não autenticado',
                loginUrl: '/login'
            });
        }

        if (tokenExpiry && Date.now() > tokenExpiry - 300000) {
            await refreshAccessToken();
        }

        req.accessToken = accessToken;
        next();

    } catch (error) {
        res.status(401).json({ error: 'Token inválido', details: error.message });
    }
}

// ============================================
// ROTAS DA API
// ============================================

// Status da autenticação
app.get('/api/auth-status', (req, res) => {
    res.json({
        authenticated: !!accessToken,
        expires: tokenExpiry ? new Date(tokenExpiry) : null
    });
});

// Buscar músicas
app.get('/api/search', ensureValidToken, async (req, res) => {
    const { q } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query obrigatória' });
    }

    try {
        const response = await axios.get(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10&market=BR`,
            {
                headers: {
                    'Authorization': `Bearer ${req.accessToken}`
                }
            }
        );

        const tracks = response.data.tracks.items.map(track => ({
            id: track.id,
            title: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            album: track.album.name,
            image: track.album.images[0]?.url,
            preview_url: track.preview_url,
            spotify_url: track.external_urls.spotify
        }));

        res.json({ tracks });

    } catch (error) {
        console.error('Erro na busca:', error.response?.data || error.message);
        res.status(500).json({ error: 'Erro na busca' });
    }
});

// Obter detalhes de uma track específica
app.get('/api/track/:id', ensureValidToken, async (req, res) => {
    try {
        const response = await axios.get(
            `https://api.spotify.com/v1/tracks/${req.params.id}`,
            {
                headers: {
                    'Authorization': `Bearer ${req.accessToken}`
                }
            }
        );

        const track = response.data;

        res.json({
            id: track.id,
            title: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            album: track.album.name,
            image: track.album.images[0]?.url,
            preview_url: track.preview_url,
            spotify_url: track.external_urls.spotify
        });

    } catch (error) {
        res.status(500).json({ error: 'Erro ao obter track' });
    }
});

// ============================================
// LIKES (CORRIGIDO - TOGGLE REAL)
// ============================================

// GET /api/likes/:trackId - Obter número de curtidas e se o usuário curtiu
app.get('/api/likes/:trackId', (req, res) => {
    const data = readData();
    const trackId = req.params.trackId;
    const userId = req.query.userId;

    const likers = data.likes[trackId] || [];
    const count = likers.length;
    const likedByUser = userId ? likers.includes(userId) : false;

    res.json({ trackId, count, likedByUser });
});

// POST /api/likes/:trackId - Toggle curtida (adicionar ou remover)
app.post('/api/likes/:trackId', (req, res) => {
    const data = readData();
    const trackId = req.params.trackId;
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId obrigatório' });
    }

    if (!data.likes[trackId]) {
        data.likes[trackId] = [];
    }

    const likers = data.likes[trackId];
    const alreadyLiked = likers.includes(userId);

    if (alreadyLiked) {
        // Remove a curtida (toggle off)
        data.likes[trackId] = likers.filter(id => id !== userId);
    } else {
        // Adiciona a curtida (toggle on)
        data.likes[trackId].push(userId);
    }

    saveData(data);

    const count = data.likes[trackId].length;
    const likedByUser = !alreadyLiked;

    res.json({ trackId, count, likedByUser });
});

// ============================================
// COMENTÁRIOS
// ============================================

// GET /api/comments/:trackId - Obter comentários de uma música
app.get('/api/comments/:trackId', (req, res) => {
    const data = readData();
    const trackId = req.params.trackId;
    const comments = data.comments[trackId] || [];
    res.json({ trackId, comments });
});

// POST /api/comments/:trackId - Adicionar comentário
app.post('/api/comments/:trackId', (req, res) => {
    const data = readData();
    const trackId = req.params.trackId;
    const { text, author } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Comentário não pode estar vazio' });
    }

    if (!data.comments[trackId]) {
        data.comments[trackId] = [];
    }

    const newComment = {
        id: Date.now().toString(),
        text: text.trim(),
        author: author || 'Anônimo',
        createdAt: new Date().toISOString()
    };

    data.comments[trackId].push(newComment);
    saveData(data);

    res.status(201).json({ comment: newComment });
});

// POST /api/comments/:trackId/:commentId/replies - Responder a um comentário
app.post('/api/comments/:trackId/:commentId/replies', (req, res) => {
    const data = readData();
    const { trackId, commentId } = req.params;
    const { text, author } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Resposta não pode estar vazia' });
    }

    if (!data.comments[trackId]) {
        return res.status(404).json({ error: 'Comentário não encontrado' });
    }

    const comment = data.comments[trackId].find(c => c.id === commentId);
    if (!comment) {
        return res.status(404).json({ error: 'Comentário não encontrado' });
    }

    if (!comment.replies) {
        comment.replies = [];
    }

    const newReply = {
        id: Date.now().toString(),
        text: text.trim(),
        author: author || 'Anônimo',
        createdAt: new Date().toISOString()
    };

    comment.replies.push(newReply);
    saveData(data);

    res.status(201).json({ reply: newReply });
});

// DELETE /api/comments/:trackId/:commentId - Remover comentário
app.delete('/api/comments/:trackId/:commentId', (req, res) => {
    const data = readData();
    const { trackId, commentId } = req.params;

    if (data.comments[trackId]) {
        data.comments[trackId] = data.comments[trackId].filter(c => c.id !== commentId);
        saveData(data);
    }

    res.json({ success: true });
});

// Proxy para preview de áudio
app.get('/api/preview/:id', ensureValidToken, async (req, res) => {
    try {
        const trackResponse = await axios.get(
            `https://api.spotify.com/v1/tracks/${req.params.id}`,
            {
                headers: {
                    'Authorization': `Bearer ${req.accessToken}`
                }
            }
        );

        const previewUrl = trackResponse.data.preview_url;

        if (!previewUrl) {
            return res.status(404).json({ error: 'Preview não disponível para esta música' });
        }

        const audioResponse = await axios.get(previewUrl, {
            responseType: 'stream'
        });

        res.set('Content-Type', 'audio/mpeg');
        res.set('Cache-Control', 'public, max-age=3600');
        audioResponse.data.pipe(res);

    } catch (error) {
        console.error("💥 Erro no preview:", error.response?.data || error.message);
        res.status(500).json({
            error: 'Erro ao carregar áudio',
            details: error.response?.data || error.message
        });
    }
});

// ============================================
// PLAYER CONTROLS
// ============================================

app.get('/api/devices', ensureValidToken, async (req, res) => {
    try {
        const response = await axios.get(
            'https://api.spotify.com/v1/me/player/devices',
            {
                headers: {
                    'Authorization': `Bearer ${req.accessToken}`
                }
            }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao obter dispositivos' });
    }
});

app.put('/api/play', ensureValidToken, async (req, res) => {
    const { track_uri, device_id } = req.body;

    try {
        await axios.put(
            `https://api.spotify.com/v1/me/player/play${device_id ? '?device_id=' + device_id : ''}`,
            track_uri ? { uris: [track_uri] } : {},
            {
                headers: {
                    'Authorization': `Bearer ${req.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            error: 'Erro ao dar play',
            details: error.response?.data?.error?.message
        });
    }
});

app.put('/api/pause', ensureValidToken, async (req, res) => {
    try {
        await axios.put(
            'https://api.spotify.com/v1/me/player/pause',
            {},
            {
                headers: {
                    'Authorization': `Bearer ${req.accessToken}`
                }
            }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao pausar' });
    }
});

// ============================================
// SERVIR FRONTEND
// ============================================

app.use(express.static('../frontend'));

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        authenticated: !!accessToken,
        timestamp: new Date()
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`
    🎵 Música do Dia - Backend
    ==========================
    Servidor rodando em: http://127.0.0.1:${PORT}

    Endpoints:
    - GET /login           → Autenticar com Spotify
    - GET /api/search?q=   → Buscar músicas
    - GET /api/track/:id   → Detalhes da música
    - GET /api/preview/:id → Stream de áudio (30s)
    - GET /api/likes/:id   → Curtidas da música
    - POST /api/likes/:id  → Toggle curtida
    - GET /api/comments/:id    → Comentários
    - POST /api/comments/:id   → Adicionar comentário
    - DELETE /api/comments/:trackId/:commentId → Remover comentário

    Para autenticar, acesse: http://127.0.0.1:${PORT}/login
    `);
});
