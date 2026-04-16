// stream-credits-server
// Standalone Express server for stream credits data
// Deploy as a NEW Render web service

const express = require('express');
const app = express();
app.use(express.json());

// ── ENV VARS (add these in Render → Environment) ──────────────
// TWITCH_CLIENT_ID
// TWITCH_CLIENT_SECRET
// TWITCH_BROADCASTER_ID       (your numeric Twitch user ID)
// TWITCH_ACCESS_TOKEN         (needs: channel:read:subscriptions + moderation:read)
// SE_JWT_TOKEN                (StreamElements → Account → Integrations → JWT Token)
// SE_CHANNEL_ID               (StreamElements channel ID)
// YOUTUBE_ACCESS_TOKEN        (OAuth token — see setup guide below)
// PORT                        (Render sets this automatically)
// ─────────────────────────────────────────────────────────────

// ── IN-MEMORY STORE FOR LIVE YOUTUBE CHAT EVENTS ─────────────
let youtubeSuperchats = [];
let youtubeSuperStickers = [];
let youtubeLiveChatId = null;
let youtubePollingInterval = null;

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

// ── TWITCH: GET MODS ──────────────────────────────────────────
async function getTwitchMods() {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${process.env.TWITCH_BROADCASTER_ID}&first=100`,
      {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
        }
      }
    );
    const data = await res.json();
    return (data.data || []).map(m => m.user_name.toUpperCase());
  } catch (e) {
    console.error('Twitch mods error:', e.message);
    return [];
  }
}

// ── STREAMELEMENTS: GET SPONSORS/TIPS ────────────────────────
async function getSESponsors() {
  try {
    const res = await fetch(
      `https://api.streamelements.com/kappa/v2/tips/${process.env.SE_CHANNEL_ID}?limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SE_JWT_TOKEN}`
        }
      }
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
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/members?part=snippet&mode=listMembers&maxResults=1000',
      {
        headers: {
          'Authorization': `Bearer ${process.env.YOUTUBE_ACCESS_TOKEN}`
        }
      }
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
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=2000`,
      {
        headers: { 'Authorization': `Bearer ${process.env.YOUTUBE_ACCESS_TOKEN}` }
      }
    );
    const data = await res.json();
    for (const item of (data.items || [])) {
      const type = item.snippet.type;
      const name = (item.authorDetails.displayName || '').toUpperCase();
      if (type === 'superChatEvent' && !youtubeSuperchats.includes(name)) {
        youtubeSuperchats.push(name);
      }
      if (type === 'superStickerEvent' && !youtubeSuperStickers.includes(name)) {
        youtubeSuperStickers.push(name);
      }
    }
    console.log(`Polled chat — superchats: ${youtubeSuperchats.length}, stickers: ${youtubeSuperStickers.length}`);
  } catch (e) {
    console.error('YouTube chat poll error:', e.message);
  }
}

// ── ROUTE: Start stream (begin YouTube chat polling) ─────────
// POST /api/start-stream
// Body: { "liveBroadcastId": "your-youtube-broadcast-id" }
// Call this when you go live on YouTube
app.post('/api/start-stream', async (req, res) => {
  const { liveBroadcastId } = req.body;
  if (!liveBroadcastId) {
    return res.status(400).json({ error: 'liveBroadcastId is required' });
  }
  try {
    const broadcastRes = await fetch(
      `https://www.googleapis.com/youtube/v3/liveBroadcasts?id=${liveBroadcastId}&part=snippet`,
      { headers: { 'Authorization': `Bearer ${process.env.YOUTUBE_ACCESS_TOKEN}` } }
    );
    const broadcastData = await broadcastRes.json();
    youtubeLiveChatId = broadcastData.items?.[0]?.snippet?.liveChatId;
    if (!youtubeLiveChatId) {
      return res.status(404).json({ error: 'Could not find liveChatId for that broadcast' });
    }
    // Reset for new stream
    youtubeSuperchats = [];
    youtubeSuperStickers = [];
    if (youtubePollingInterval) clearInterval(youtubePollingInterval);
    youtubePollingInterval = setInterval(() => pollYouTubeLiveChat(youtubeLiveChatId), 15000);
    console.log(`Stream started — polling liveChatId: ${youtubeLiveChatId}`);
    res.json({ ok: true, liveChatId: youtubeLiveChatId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ROUTE: Stop stream ────────────────────────────────────────
// POST /api/stop-stream
app.post('/api/stop-stream', (req, res) => {
  if (youtubePollingInterval) {
    clearInterval(youtubePollingInterval);
    youtubePollingInterval = null;
  }
  console.log('Stream stopped — polling halted');
  res.json({ ok: true });
});

// ── ROUTE: Main credits data endpoint ────────────────────────
// GET /api/stream-credits
// Called by stream-credits.html on GitHub Pages at load time
app.get('/api/stream-credits', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const [twitchSubscribers, mods, seSponsors, youtubeMembers] = await Promise.all([
    getTwitchSubscribers(),
    getTwitchMods(),
    getSESponsors(),
    getYouTubeMembers()
  ]);
  res.json({
    youtubeMembers,
    youtubeSuperchats:    [...youtubeSuperchats],
    youtubeSuperStickers: [...youtubeSuperStickers],
    seSponsors,
    twitchSubscribers,
    mods,
    generatedAt: new Date().toISOString()
  });
});

// ── ROUTE: Health check ───────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'stream-credits-server running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Stream credits server running on port ${PORT}`));
