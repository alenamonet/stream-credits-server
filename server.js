// stream-credits-server
// Standalone Express server for stream credits data

const express = require('express');
const app = express();
app.use(express.json());

// ── ENV VARS (add these in Render → Environment) ──────────────
// TWITCH_CLIENT_ID
// TWITCH_CLIENT_SECRET
// TWITCH_BROADCASTER_ID
// TWITCH_ACCESS_TOKEN
// SE_JWT_TOKEN
// SE_CHANNEL_ID
// YOUTUBE_CLIENT_ID
// YOUTUBE_CLIENT_SECRET
// YOUTUBE_REDIRECT_URI = https://stream-credits-server.onrender.com/auth/youtube/callback
// PORT (Render sets automatically)
// ─────────────────────────────────────────────────────────────

// ── IN-MEMORY STORE ───────────────────────────────────────────
let youtubeAccessToken = null;
let youtubeRefreshToken = null;
let youtubeSuperchats = [];
let youtubeSuperStickers = [];
let youtubeMods = [];
let youtubeLiveChatId = null;
let youtubePollingInterval = null;

// ── YOUTUBE: REFRESH ACCESS TOKEN ────────────────────────────
async function refreshYouTubeToken() {
  if (!youtubeRefreshToken) return false;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        refresh_token: youtubeRefreshToken,
        grant_type: 'refresh_token'
      })
    });
    const data = await res.json();
    if (data.access_token) {
      youtubeAccessToken = data.access_token;
      console.log('YouTube token refreshed');
      return true;
    }
  } catch (e) {
    console.error('Token refresh error:', e.message);
  }
  return false;
}

// Auto-refresh token every 45 minutes
setInterval(refreshYouTubeToken, 45 * 60 * 1000);

// ── YOUTUBE OAUTH: Step 1 — redirect to Google login ─────────
// Visit this URL in your browser ONE TIME to authorize
app.get('/auth/youtube', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.channel-memberships.creator'
  ].join(' ');

  const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.YOUTUBE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.YOUTUBE_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  res.redirect(url);
});

// ── YOUTUBE OAUTH: Step 2 — handle callback ───────────────────
app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
        grant_type: 'authorization_code',
        code
      })
    });
    const tokens = await tokenRes.json();
    if (tokens.access_token) {
      youtubeAccessToken = tokens.access_token;
      youtubeRefreshToken = tokens.refresh_token;
      console.log('YouTube authorized successfully!');
      res.send(`
        <h2>✅ YouTube Connected!</h2>
        <p>Your stream credits server is now authorized.</p>
        <p>You can close this tab.</p>
      `);
    } else {
      res.status(500).send('Failed to get token: ' + JSON.stringify(tokens));
    }
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ── TWITCH: GET SUBSCRIBERS ───────────────────────────────────
async function getTwitchSubscribers() {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${process.env.TWITCH_BROADCASTER_ID}&first=100`,
      {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
        }
      }
    );
    const data = await res.json();
    return (data.data || [])
      .filter(s => s.user_id !== process.env.TWITCH_BROADCASTER_ID)
      .map(s => s.user_name.toUpperCase());
  } catch (e) {
    console.error('Twitch subs error:', e.message);
    return [];
  }
}

// ── STREAMELEMENTS: GET SPONSORS ─────────────────────────────
async function getSESponsors() {
  try {
    const res = await fetch(
      `https://api.streamelements.com/kappa/v2/tips/${process.env.SE_CHANNEL_ID}?limit=100`,
      { headers: { 'Authorization': `Bearer ${process.env.SE_JWT_TOKEN}` } }
    );
    const data = await res.json();
    return (data.docs || []).map(t => t.donation.user.username.toUpperCase());
  } catch (e) {
    console.error('SE sponsors error:', e.message);
    return [];
  }
}

// ── YOUTUBE: GET MEMBERS ──────────────────────────────────────
async function getYouTubeMembers() {
  if (!youtubeAccessToken) return [];
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/members?part=snippet&mode=listMembers&maxResults=1000',
      { headers: { 'Authorization': `Bearer ${youtubeAccessToken}` } }
    );
    const data = await res.json();
    return (data.items || []).map(m =>
      (m.snippet.memberDetails.displayName || 'Unknown').toUpperCase()
    );
  } catch (e) {
    console.error('YouTube members error:', e.message);
    return [];
  }
}

// ── YOUTUBE: POLL LIVE CHAT ───────────────────────────────────
async function pollYouTubeLiveChat(liveChatId) {
  if (!youtubeAccessToken) return;
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=2000`,
      { headers: { 'Authorization': `Bearer ${youtubeAccessToken}` } }
    );
    const data = await res.json();
    for (const item of (data.items || [])) {
      const type = item.snippet.type;
      const name = (item.authorDetails.displayName || '').toUpperCase();
      const isMod = item.authorDetails.isChatModerator;
      if (type === 'superChatEvent' && !youtubeSuperchats.includes(name)) youtubeSuperchats.push(name);
      if (type === 'superStickerEvent' && !youtubeSuperStickers.includes(name)) youtubeSuperStickers.push(name);
      if (isMod && !youtubeMods.includes(name)) youtubeMods.push(name);
    }
    console.log(`Polled — superchats:${youtubeSuperchats.length} stickers:${youtubeSuperStickers.length} mods:${youtubeMods.length}`);
  } catch (e) {
    console.error('YouTube chat poll error:', e.message);
  }
}

// ── ROUTE: Start stream ───────────────────────────────────────
app.post('/api/start-stream', async (req, res) => {
  const { liveBroadcastId } = req.body;
  if (!liveBroadcastId) return res.status(400).json({ error: 'liveBroadcastId required' });
  try {
    const broadcastRes = await fetch(
      `https://www.googleapis.com/youtube/v3/liveBroadcasts?id=${liveBroadcastId}&part=snippet`,
      { headers: { 'Authorization': `Bearer ${youtubeAccessToken}` } }
    );
    const broadcastData = await broadcastRes.json();
    youtubeLiveChatId = broadcastData.items?.[0]?.snippet?.liveChatId;
    if (!youtubeLiveChatId) return res.status(404).json({ error: 'Could not find liveChatId' });
    youtubeSuperchats = [];
    youtubeSuperStickers = [];
    youtubeMods = [];
    if (youtubePollingInterval) clearInterval(youtubePollingInterval);
    youtubePollingInterval = setInterval(() => pollYouTubeLiveChat(youtubeLiveChatId), 15000);
    console.log(`Stream started — polling liveChatId: ${youtubeLiveChatId}`);
    res.json({ ok: true, liveChatId: youtubeLiveChatId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ROUTE: Stop stream ────────────────────────────────────────
app.post('/api/stop-stream', (req, res) => {
  if (youtubePollingInterval) { clearInterval(youtubePollingInterval); youtubePollingInterval = null; }
  res.json({ ok: true });
});

// ── ROUTE: Main credits endpoint ──────────────────────────────
app.get('/api/stream-credits', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const [twitchSubscribers, seSponsors, youtubeMembers] = await Promise.all([
    getTwitchSubscribers(),
    getSESponsors(),
    getYouTubeMembers()
  ]);
  res.json({
    youtubeMembers,
    youtubeSuperchats:    [...youtubeSuperchats],
    youtubeSuperStickers: [...youtubeSuperStickers],
    seSponsors,
    twitchSubscribers,
    mods: [...youtubeMods],
    generatedAt: new Date().toISOString()
  });
});

// ── Serve credits page ────────────────────────────────────────
app.get('/credits', (req, res) => {
  res.sendFile(__dirname + '/stream-credits.html');
});

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ 
  status: 'stream-credits-server running',
  youtubeConnected: !!youtubeAccessToken
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Stream credits server running on port ${PORT}`));
