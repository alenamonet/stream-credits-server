// stream-credits-server/server.js
// ─────────────────────────────────────────────────────────────
// ENV VARS — set these in Render → Environment
// ─────────────────────────────────────────────────────────────
// TWITCH_CLIENT_ID
// TWITCH_CLIENT_SECRET
// TWITCH_BROADCASTER_ID
// TWITCH_ACCESS_TOKEN
// SE_JWT_TOKEN
// SE_CHANNEL_ID
// YOUTUBE_CLIENT_ID
// YOUTUBE_CLIENT_SECRET
// YOUTUBE_REDIRECT_URI     = https://stream-credits-server.onrender.com/auth/youtube/callback
// YOUTUBE_REFRESH_TOKEN    ← NEW: paste in after first OAuth login (see /auth/youtube)
// RESET_SECRET             ← NEW: any random string, used by Nightbot reset command
// PORT (Render sets automatically)
// ─────────────────────────────────────────────────────────────

const express = require('express');
const app = express();
app.use(express.json());

// Allow the OBS overlay to fetch from this server
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ── IN-MEMORY STORE ───────────────────────────────────────────
let youtubeAccessToken  = null;
let youtubeRefreshToken = process.env.YOUTUBE_REFRESH_TOKEN || null; // ← persists across restarts
let youtubeSuperchats   = [];
let youtubeSuperStickers = [];
let youtubeMods         = [];
let youtubeLiveChatId   = null;
let youtubeNextPageToken = null;
let youtubePollingInterval = null;

// ── YOUTUBE: REFRESH ACCESS TOKEN ────────────────────────────
async function refreshYouTubeToken() {
  if (!youtubeRefreshToken) {
    console.log('[YouTube] No refresh token — visit /auth/youtube to connect');
    return false;
  }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        refresh_token: youtubeRefreshToken,
        grant_type:    'refresh_token'
      })
    });
    const data = await res.json();
    if (data.access_token) {
      youtubeAccessToken = data.access_token;
      console.log('[YouTube] ✓ Access token refreshed');
      return true;
    } else {
      console.error('[YouTube] Token refresh failed:', JSON.stringify(data));
      return false;
    }
  } catch (e) {
    console.error('[YouTube] Token refresh error:', e.message);
    return false;
  }
}

// Auto-refresh access token every 45 min (they expire after 60)
setInterval(refreshYouTubeToken, 45 * 60 * 1000);

// ── YOUTUBE: AUTO-DETECT ACTIVE BROADCAST ────────────────────
async function findActiveBroadcast() {
  if (!youtubeAccessToken) return null;
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all',
      { headers: { 'Authorization': `Bearer ${youtubeAccessToken}` } }
    );
    const data = await res.json();
    const broadcast = data.items?.[0];
    if (broadcast) {
      console.log(`[YouTube] Found active broadcast: "${broadcast.snippet.title}"`);
      return broadcast.snippet.liveChatId;
    }
    return null;
  } catch (e) {
    console.error('[YouTube] Error finding broadcast:', e.message);
    return null;
  }
}

// ── YOUTUBE: POLL LIVE CHAT ───────────────────────────────────
async function pollYouTubeLiveChat() {
  if (!youtubeAccessToken || !youtubeLiveChatId) return;
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');
    url.searchParams.set('liveChatId', youtubeLiveChatId);
    url.searchParams.set('part', 'snippet,authorDetails');
    url.searchParams.set('maxResults', '2000');
    if (youtubeNextPageToken) url.searchParams.set('pageToken', youtubeNextPageToken);

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${youtubeAccessToken}` }
    });
    const data = await res.json();

    if (data.error) {
      // Chat ended or access denied — stop polling
      if (data.error.code === 403 || data.error.code === 404) {
        console.log('[YouTube] Chat ended, stopping poller');
        clearInterval(youtubePollingInterval);
        youtubePollingInterval = null;
        youtubeLiveChatId = null;
      }
      return;
    }

    youtubeNextPageToken = data.nextPageToken;

    for (const item of (data.items || [])) {
      const type = item.snippet.type;
      const name = item.authorDetails.displayName || '';
      const isMod = item.authorDetails.isChatModerator;

      if (type === 'superChatEvent'    && !youtubeSuperchats.includes(name))    youtubeSuperchats.push(name);
      if (type === 'superStickerEvent' && !youtubeSuperStickers.includes(name)) youtubeSuperStickers.push(name);
      if (isMod                        && !youtubeMods.includes(name))           youtubeMods.push(name);
    }

    console.log(`[YouTube] Polled — superchats:${youtubeSuperchats.length} stickers:${youtubeSuperStickers.length}`);

  } catch (e) {
    console.error('[YouTube] Poll error:', e.message);
  }
}

// ── YOUTUBE: START POLLING ────────────────────────────────────
// Call this when a stream goes live. If no liveChatId provided, auto-detects.
async function startYouTubePolling(liveChatId = null) {
  if (youtubePollingInterval) {
    clearInterval(youtubePollingInterval);
    youtubePollingInterval = null;
  }

  youtubeLiveChatId = liveChatId || await findActiveBroadcast();

  if (!youtubeLiveChatId) {
    console.log('[YouTube] No live chat found — will retry in 60s');
    // Retry finding an active broadcast every 60s until found
    const retryTimer = setInterval(async () => {
      youtubeLiveChatId = await findActiveBroadcast();
      if (youtubeLiveChatId) {
        clearInterval(retryTimer);
        youtubePollingInterval = setInterval(pollYouTubeLiveChat, 15000);
        pollYouTubeLiveChat();
        console.log('[YouTube] ✓ Found broadcast, polling started');
      }
    }, 60000);
    return;
  }

  youtubePollingInterval = setInterval(pollYouTubeLiveChat, 15000);
  pollYouTubeLiveChat(); // run immediately
  console.log(`[YouTube] ✓ Polling started for liveChatId: ${youtubeLiveChatId}`);
}

// ── TWITCH: GET SUBSCRIBERS ───────────────────────────────────
async function getTwitchSubscribers() {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${process.env.TWITCH_BROADCASTER_ID}&first=100`,
      {
        headers: {
          'Client-ID':     process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
        }
      }
    );
    const data = await res.json();
    if (data.error) {
      console.error('[Twitch] API error:', data.message);
      return [];
    }
    return (data.data || [])
      .filter(s => s.user_id !== process.env.TWITCH_BROADCASTER_ID)
      .map(s => s.user_name);
  } catch (e) {
    console.error('[Twitch] Fetch error:', e.message);
    return [];
  }
}

// ── STREAMELEMENTS: GET DONORS ────────────────────────────────
async function getSEDonors() {
  try {
    const res = await fetch(
      `https://api.streamelements.com/kappa/v2/tips/${process.env.SE_CHANNEL_ID}?limit=100&sort=-createdAt`,
      { headers: { 'Authorization': `Bearer ${process.env.SE_JWT_TOKEN}` } }
    );
    const data = await res.json();
    // Deduplicate donor names
    const seen = new Set();
    return (data.docs || [])
      .map(t => t.donation?.user?.username)
      .filter(name => name && !seen.has(name) && seen.add(name));
  } catch (e) {
    console.error('[StreamElements] Fetch error:', e.message);
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
    if (data.error) {
      console.error('[YouTube] Members error:', data.error.message);
      return [];
    }
    return (data.items || []).map(m => m.snippet?.memberDetails?.displayName || 'Unknown');
  } catch (e) {
    console.error('[YouTube] Members fetch error:', e.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

// ── GET /  ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status:           'stream-credits-server running ✓',
  youtubeConnected: !!youtubeAccessToken,
  twitchConfigured: !!process.env.TWITCH_ACCESS_TOKEN,
  seConfigured:     !!process.env.SE_JWT_TOKEN,
  liveChat:         youtubeLiveChatId ? 'polling ✓' : 'not started',
  creditCounts: {
    superChats:   youtubeSuperchats.length,
    stickers:     youtubeSuperStickers.length,
    mods:         youtubeMods.length
  }
}));

// ── GET /health  ──────────────────────────────────────────────
// For UptimeRobot — keeps Render free tier awake
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── GET /credits/reset  ───────────────────────────────────────
// Clears live-chat data at the start of each stream.
// Protected by RESET_SECRET so only you can trigger it.
//
// Nightbot command:
//   !startstream
//   $(urlfetch https://stream-credits-server.onrender.com/credits/reset?token=YOUR_RESET_SECRET)
//   Usable by: Moderators
//
app.get('/credits/reset', (req, res) => {
  if (req.query.token !== process.env.RESET_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  // Clear live-event data (keep nextPageToken so we don't re-read old events)
  youtubeSuperchats    = [];
  youtubeSuperStickers = [];
  youtubeMods          = [];
  youtubeNextPageToken = null;

  // Re-start YouTube polling to find new broadcast if needed
  startYouTubePolling();

  console.log('[Server] ✓ Credits reset');
  res.send('✓ Credits cleared! Ready for a new stream.');
});

// ── GET /api/stream-credits  ──────────────────────────────────
// Main endpoint — the overlay fetches this when the scene opens.
// Returns all collected names as JSON.
app.get('/api/stream-credits', async (req, res) => {
  const [twitchSubscribers, seSponsors, youtubeMembers] = await Promise.all([
    getTwitchSubscribers(),
    getSEDonors(),
    getYouTubeMembers()
  ]);

  res.json({
    youtubeMembers,
    youtubeSuperchats:    [...youtubeSuperchats],
    youtubeSuperStickers: [...youtubeSuperStickers],
    seSponsors,
    twitchSubscribers,
    generatedAt: new Date().toISOString()
  });
});

// ── POST /api/start-stream  ───────────────────────────────────
// Optionally provide liveBroadcastId to pin a specific broadcast.
// If omitted, auto-detects the active broadcast.
app.post('/api/start-stream', async (req, res) => {
  const { liveBroadcastId } = req.body;

  if (liveBroadcastId) {
    // Resolve provided broadcast ID to a liveChatId
    try {
      const broadcastRes = await fetch(
        `https://www.googleapis.com/youtube/v3/liveBroadcasts?id=${liveBroadcastId}&part=snippet`,
        { headers: { 'Authorization': `Bearer ${youtubeAccessToken}` } }
      );
      const broadcastData = await broadcastRes.json();
      const liveChatId = broadcastData.items?.[0]?.snippet?.liveChatId;
      if (!liveChatId) return res.status(404).json({ error: 'Could not find liveChatId for that broadcast' });
      await startYouTubePolling(liveChatId);
      return res.json({ ok: true, liveChatId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // No ID provided — auto-detect
  await startYouTubePolling();
  res.json({ ok: true, message: 'Auto-detecting active broadcast...' });
});

// ── POST /api/stop-stream  ────────────────────────────────────
app.post('/api/stop-stream', (req, res) => {
  if (youtubePollingInterval) { clearInterval(youtubePollingInterval); youtubePollingInterval = null; }
  res.json({ ok: true });
});

// ── YOUTUBE OAUTH: Step 1  ────────────────────────────────────
// Visit this URL once in your browser to authorize YouTube.
// After authorizing, the refresh token is printed in Render logs.
// Copy it → add as YOUTUBE_REFRESH_TOKEN env var → redeploy.
app.get('/auth/youtube', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.channel-memberships.creator'
  ].join(' ');

  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    `client_id=${process.env.YOUTUBE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.YOUTUBE_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  res.redirect(url);
});

// ── YOUTUBE OAUTH: Step 2 — callback  ────────────────────────
app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        redirect_uri:  process.env.YOUTUBE_REDIRECT_URI,
        grant_type:    'authorization_code',
        code
      })
    });
    const tokens = await tokenRes.json();

    if (tokens.access_token) {
      youtubeAccessToken  = tokens.access_token;
      youtubeRefreshToken = tokens.refresh_token;

      // ⬇ IMPORTANT: Copy this from Render Logs → add as YOUTUBE_REFRESH_TOKEN env var
      console.log('═══════════════════════════════════════════════════');
      console.log('✓ YouTube authorized!');
      console.log('COPY THIS REFRESH TOKEN → Add to Render env vars:');
      console.log('YOUTUBE_REFRESH_TOKEN =', tokens.refresh_token);
      console.log('═══════════════════════════════════════════════════');

      // Auto-start polling now that we're authorized
      startYouTubePolling();

      res.send(`
        <h2 style="font-family:sans-serif">✅ YouTube Connected!</h2>
        <p style="font-family:sans-serif">
          <strong>Important:</strong> Copy your refresh token from the Render logs
          and add it as <code>YOUTUBE_REFRESH_TOKEN</code> in your Render environment variables.
          This prevents you from needing to re-authorize after every restart.
        </p>
        <p style="font-family:sans-serif">You can close this tab.</p>
      `);
    } else {
      res.status(500).send('Failed to get token: ' + JSON.stringify(tokens));
    }
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ── Serve credits overlay  ────────────────────────────────────
app.get('/credits', (req, res) => {
  res.sendFile(__dirname + '/stream-credits.html');
});

// ════════════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n✓ stream-credits-server running on port ${PORT}`);
  console.log('────────────────────────────────────────────────');

  // If we have a stored refresh token, get a fresh access token immediately
  if (youtubeRefreshToken) {
    const ok = await refreshYouTubeToken();
    if (ok) {
      // Auto-start polling — will find the active broadcast when stream goes live
      startYouTubePolling();
    }
  } else {
    console.log('[YouTube] ⚠ No refresh token found.');
    console.log('[YouTube] Visit https://stream-credits-server.onrender.com/auth/youtube to connect.');
  }

  console.log('────────────────────────────────────────────────\n');
});
