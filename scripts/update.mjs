import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const dataPath = path.resolve(process.cwd(), 'data.js');
const apiKey = process.env.YOUTUBE_API_KEY;
const apiBase = (process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, '');

function fail(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}

function count(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

if (!apiKey) fail('YOUTUBE_API_KEY is not set.');

let data;
try {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(dataPath, 'utf8'), sandbox, { filename: 'data.js', timeout: 1000 });
  data = sandbox.window.KPOPETTE_DATA;
} catch (error) {
  fail('Could not read data.js: ' + error.message);
}

if (!data || !Array.isArray(data.acts) || !data.acts.length) fail('data.js contains no acts.');

const ids = [...new Set(data.acts.map((act) => act.video && act.video.id).filter(Boolean))];
if (!ids.length) fail('No YouTube video IDs found in data.js.');

const items = new Map();
for (let index = 0; index < ids.length; index += 50) {
  const batch = ids.slice(index, index + 50);
  const url = apiBase + '/videos?part=snippet%2Cstatistics&id=' + encodeURIComponent(batch.join(',')) + '&key=' + encodeURIComponent(apiKey);
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    fail('YouTube API returned ' + response.status + ': ' + body.slice(0, 300));
  }
  const payload = await response.json();
  if (payload.error) fail('YouTube API: ' + payload.error.message);
  for (const item of payload.items || []) items.set(item.id, item);
}

let changed = 0;
const missing = [];

for (const act of data.acts) {
  const video = act.video;
  if (!video || !video.id) {
    missing.push(act.name);
    continue;
  }
  const item = items.get(video.id);
  if (!item) {
    missing.push(act.name + ' (' + video.id + ')');
    continue;
  }

  const views = count(item.statistics && item.statistics.viewCount);
  const likes = count(item.statistics && item.statistics.likeCount);
  const title = item.snippet && item.snippet.title;
  const channel = item.snippet && item.snippet.channelTitle;
  const before = JSON.stringify([video.views, video.likes, video.title, video.channel]);

  if (views != null) video.views = views;
  if (likes != null) video.likes = likes;
  if (title) video.title = title;
  if (channel) video.channel = channel;
  video.url = 'https://www.youtube.com/watch?v=' + video.id;
  video.thumb = 'https://i.ytimg.com/vi/' + video.id + '/hqdefault.jpg';

  if (before !== JSON.stringify([video.views, video.likes, video.title, video.channel])) changed += 1;
}

function computeHype(group) {
  const list = data.acts.filter((act) => act.group === group && act.video && Number.isFinite(Number(act.video.views)) && Number.isFinite(Number(act.video.likes)));
  if (!list.length) return;
  const views = list.map((act) => Number(act.video.views));
  const likes = list.map((act) => Number(act.video.likes));
  const minViews = Math.min(...views);
  const maxViews = Math.max(...views);
  const minLikes = Math.min(...likes);
  const maxLikes = Math.max(...likes);
  for (const act of list) {
    const viewScore = maxViews === minViews ? 1 : (Number(act.video.views) - minViews) / (maxViews - minViews);
    const likeScore = maxLikes === minLikes ? 1 : (Number(act.video.likes) - minLikes) / (maxLikes - minLikes);
    act.hype = Math.round(((viewScore + likeScore) / 2) * 1000) / 10;
  }
}

computeHype('kpop');
computeHype('asia');
data.stand = new Date().toISOString();

const output = 'window.KPOPETTE_DATA = ' + JSON.stringify(data, null, 2) + ';\n';
fs.writeFileSync(dataPath, output, 'utf8');

console.log('Updated ' + changed + ' of ' + data.acts.length + ' acts from ' + items.size + ' YouTube records.');
if (missing.length) console.warn('No YouTube data for: ' + missing.join(', '));

for (const group of ['kpop', 'asia']) {
  const top = data.acts
    .filter((act) => act.group === group)
    .sort((a, b) => (b.hype - a.hype) || a.name.localeCompare(b.name, 'de'))
    .slice(0, 3)
    .map((act) => act.name + ' ' + act.hype)
    .join(' · ');
  console.log((group === 'kpop' ? 'K-Pop' : 'Asia') + ': ' + top);
}
