// stream-credits-server
// Standalone Express server for stream credits data

const express = require('express');
const app = express();
app.use(express.json());

// ── ENV VARS (add these in Render → Environment) ──────────────
// TWITCH_CLIENT_ID
// TWITCH_CLIENT_SECRET
// TWITCH_BROADCASTER_ID       (your numeric Twitch user ID: 1351361103)
// TWITCH_ACCESS_TOKEN         (needs: channel:read:subscriptions)
// SE_JWT_TOKEN                (StreamElements → Account → Channels → JWT Token)
// SE_CHANNEL_ID               (StreamElements channel ID)
// YOUTUBE_ACCESS_TOKEN        (OAuth token — see setup guide)
// PORT                        (Render sets this automatically)
// ─────────────────────────────────────────────────────────────

// ── IN-MEMORY STORE FOR LIVE YOUTUBE CHAT EVENTS ─────────────
let youtubeSuperchats = [];
let youtubeSuperStickers = [];
let youtubeMods = [];
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
// Logs superchats, super stickers, AND mods during the stream
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
      const isMod = item.authorDetails.isChatModerator;

      if (type === 'superChatEvent' && !youtubeSuperchats.includes(name)) {
        youtubeSuperchats.push(name);
      }
      if (type === 'superStickerEvent' && !youtubeSuperStickers.includes(name)) {
        youtubeSuperStickers.push(name);
      }
      if (isMod && !youtubeMods.includes(name)) {
        youtubeMods.push(name);
      }
    }
    console.log(`Polled chat — superchats: ${youtubeSuperchats.length}, stickers: ${youtubeSuperStickers.length}, mods: ${youtubeMods.length}`);
  } catch (e) {
    console.error('YouTube chat poll error:', e.message);
  }
}

// ── ROUTE: Start stream ───────────────────────────────────────
// POST /api/start-stream  { "liveBroadcastId": "your-youtube-broadcast-id" }
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
      return res.status(404).json({ error: 'Could not find liveChatId' });
    }
    // Reset for new stream
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
  if (youtubePollingInterval) {
    clearInterval(youtubePollingInterval);
    youtubePollingInterval = null;
  }
  console.log('Stream stopped — polling halted');
  res.json({ ok: true });
});

// ── ROUTE: Main credits endpoint ──────────────────────────────
// GET /api/stream-credits
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
    mods: [...youtubeMods],   // YouTube mods only
    generatedAt: new Date().toISOString()
  });
});

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'stream-credits-server running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Stream credits server running on port ${PORT}`));
