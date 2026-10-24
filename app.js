'use strict';

/* =====================================================================
   WeatherMap – Asynchronous client-side SPA (vanilla ES6+, no frameworks)
   Phase 1: DOM setup & map init
   Phase 2: Asynchronous geocoding (Nominatim / OpenStreetMap)
   Phase 3: OpenWeatherMap fetch (chained)
   Phase 4: Map centering (animated) & single marker
   Phase 5: InfoWindow (popup) with weather + Share button
   Bonus : Share, Favorites (LocalStorage), 5-day forecast, AI chatbot
   ===================================================================== */

/* ---------- Configuration: put your own keys here ---------- */
const CONFIG = {
  OPENWEATHER_API_KEY: '6cec3847286a28cd83c771fb59e0c992',
  OPENAI_API_KEY: (window.LOCAL_SECRETS && window.LOCAL_SECRETS.OPENAI_API_KEY) || 'YOUR_OPENAI_API_KEY',
  OPENAI_MODEL: 'gpt-4o-mini',
  DEFAULT_VIEW: { lat: 15.5007, lng: 32.5599, zoom: 6 }, // Khartoum, Sudan
  CITY_ZOOM: 10,
  FAVORITES_KEY: 'weathermap:favorites'
};

/* ---------- DOM references ---------- */
const form = document.getElementById('weather-form');
const input = document.getElementById('location-input');
const submitBtn = document.getElementById('get-weather-btn');
const favBtn = document.getElementById('fav-btn');
const loadingEl = document.getElementById('loading');
const alertsEl = document.getElementById('alerts');
const favList = document.getElementById('favorites-list');
const favEmpty = document.getElementById('favorites-empty');
const forecastSection = document.getElementById('forecast-section');
const forecastGrid = document.getElementById('forecast-grid');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatLog = document.getElementById('chat-log');

/* ---------- Application state ---------- */
const state = {
  map: null,
  marker: null,
  current: null,      // last successful weather summary
  favorites: [],
  chatHistory: []
};

/* ---------- Small helpers ---------- */
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const iconUrl = (code, size = '2x') => `https://openweathermap.org/img/wn/${code}@${size}.png`;

function requireKey(value, label) {
  if (!value || value.startsWith('YOUR_')) {
    throw new Error(`Missing ${label}. Open app.js and set it in the CONFIG object.`);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let data = null;
  try { data = await response.json(); } catch (_) { /* non-JSON body */ }
  if (!response.ok) {
    const detail = data && (data.message || (data.error && data.error.message));
    throw new Error(detail ? `Request failed (${response.status}): ${detail}` : `Request failed (${response.status}).`);
  }
  return data;
}

/* ---------- Loading & error UI (never silent console errors) ---------- */
function setLoading(isLoading) {
  loadingEl.hidden = !isLoading;
  submitBtn.disabled = isLoading;
}

function showAlert(message, type = 'error') {
  const card = document.createElement('div');
  card.className = type === 'info' ? 'alert-card info' : 'alert-card';
  card.setAttribute('role', 'alert');

  const text = document.createElement('span');
  text.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'alert-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => card.remove());

  card.append(text, close);
  alertsEl.appendChild(card);
  if (type === 'info') setTimeout(() => card.remove(), 3500);
}

function clearAlerts() { alertsEl.replaceChildren(); }

/* =====================================================================
   PHASE 1 – DOM setup & map initialisation
   ===================================================================== */
function initMap() {
  const { lat, lng, zoom } = CONFIG.DEFAULT_VIEW;
  state.map = L.map('map').setView([lat, lng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(state.map);

  // Attach the Share handler every time a popup (InfoWindow) opens
  state.map.on('popupopen', (event) => {
    const btn = event.popup.getElement().querySelector('.share-btn');
    if (btn) btn.addEventListener('click', shareWeather);
  });
}

/* =====================================================================
   PHASE 2 – Asynchronous geocoding (Nominatim JSON)
   ===================================================================== */
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const results = await fetchJson(url, { headers: { Accept: 'application/json' } });
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`Could not find a location named “${query}”. Check the spelling and try again.`);
  }
  const best = results[0];
  return { lat: parseFloat(best.lat), lng: parseFloat(best.lon), label: best.display_name };
}

/* =====================================================================
   PHASE 3 – OpenWeatherMap (current weather, chained after geocoding)
   ===================================================================== */
async function fetchWeather(lat, lng) {
  requireKey(CONFIG.OPENWEATHER_API_KEY, 'OpenWeatherMap API key');
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${CONFIG.OPENWEATHER_API_KEY}`;
  return fetchJson(url);
}

async function fetchForecast(lat, lng) {
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&units=metric&appid=${CONFIG.OPENWEATHER_API_KEY}`;
  return fetchJson(url);
}

function summarize(data, loc, query) {
  const w = (data.weather && data.weather[0]) || {};
  return {
    city: data.name || query,
    country: data.sys && data.sys.country ? data.sys.country : '',
    temp: Math.round(data.main.temp),
    description: w.description || 'n/a',
    icon: w.icon || '01d',
    humidity: data.main.humidity,
    wind: data.wind ? data.wind.speed : 0,
    clouds: data.clouds ? data.clouds.all : 0,
    lat: loc.lat,
    lng: loc.lng
  };
}

/* =====================================================================
   PHASE 4 – Animated centering + single marker (old marker removed)
   ===================================================================== */
function placeMarker(summary) {
  if (state.marker) {                       // clear previous marker from memory
    state.marker.remove();
    state.marker = null;
  }
  const point = [summary.lat, summary.lng];
  state.map.flyTo(point, CONFIG.CITY_ZOOM, { animate: true, duration: 1.5 });

  state.marker = L.marker(point).addTo(state.map);
  state.marker.bindPopup(buildInfoWindow(summary), { maxWidth: 260 });

  // Open the InfoWindow when the animation settles (with a safety fallback)
  const marker = state.marker;
  state.map.once('moveend', () => marker.openPopup());
  setTimeout(() => { if (state.marker === marker && !marker.isPopupOpen()) marker.openPopup(); }, 2000);
}

/* =====================================================================
   PHASE 5 – InfoWindow: city, temp, clouds, humidity, wind, icon, Share
   ===================================================================== */
function buildInfoWindow(s) {
  const place = s.country ? `${s.city}, ${s.country}` : s.city;
  return `
    <div class="weather-card">
      <div class="weather-card-city">${escapeHtml(place)}</div>
      <div class="weather-card-main">
        <img class="weather-card-icon" src="${iconUrl(s.icon)}" alt="${escapeHtml(s.description)}">
        <span class="weather-card-temp">${s.temp}<sup>°C</sup></span>
      </div>
      <div class="weather-card-desc">${escapeHtml(s.description)}</div>
      <ul class="weather-card-details">
        <li>Clouds: ${s.clouds}%</li>
        <li>Humidity: ${s.humidity}%</li>
        <li>Wind: ${s.wind} m/s</li>
      </ul>
      <button type="button" class="share-btn">Share</button>
    </div>`;
}

function weatherMessage(s) {
  const place = s.country ? `${s.city}, ${s.country}` : s.city;
  return `Weather in ${place}: ${s.temp}°C, ${s.description}. Clouds ${s.clouds}%, humidity ${s.humidity}%, wind ${s.wind} m/s.`;
}

/* ---------- Bonus: Share (Web Share API, clipboard fallback) ---------- */
async function shareWeather() {
  if (!state.current) return;
  const text = weatherMessage(state.current);
  try {
    if (navigator.share) {
      await navigator.share({ title: 'WeatherMap', text });
    } else {
      await navigator.clipboard.writeText(text);
      showAlert('Weather message copied to clipboard.', 'info');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user closed the share sheet
    showAlert('Sharing failed: ' + err.message);
  }
}

/* ---------- Bonus: 5-day forecast (5-day / 3-hour API, grouped per day) ---------- */
function groupForecast(list) {
  const days = new Map();
  list.forEach((item) => {
    const [date, time] = item.dt_txt.split(' ');
    const hour = parseInt(time.slice(0, 2), 10);
    const day = days.get(date) || { date, min: Infinity, max: -Infinity, best: null, bestGap: Infinity };
    day.min = Math.min(day.min, item.main.temp_min);
    day.max = Math.max(day.max, item.main.temp_max);
    const gap = Math.abs(hour - 12);                 // pick the entry closest to midday
    if (gap < day.bestGap) { day.bestGap = gap; day.best = item.weather[0]; }
    days.set(date, day);
  });
  const all = [...days.values()];
  return all.length > 5 ? all.slice(1, 6) : all;      // next 5 days
}

function renderForecast(data) {
  forecastGrid.replaceChildren();
  groupForecast(data.list).forEach((day) => {
    const card = document.createElement('div');
    card.className = 'forecast-card';

    const name = document.createElement('div');
    name.className = 'forecast-day';
    name.textContent = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    const img = document.createElement('img');
    img.className = 'forecast-icon';
    img.src = iconUrl(day.best.icon);
    img.alt = day.best.description;

    const temps = document.createElement('div');
    temps.className = 'forecast-temps';
    temps.textContent = `${Math.round(day.max)}° / ${Math.round(day.min)}°C`;

    const desc = document.createElement('div');
    desc.className = 'forecast-desc';
    desc.textContent = day.best.description;

    card.append(name, img, temps, desc);
    forecastGrid.appendChild(card);
  });
  forecastSection.hidden = false;
}

/* ---------- Main workflow: submit → geocode → weather → map ---------- */
async function lookupWeather(query) {
  clearAlerts();
  setLoading(true);
  try {
    const loc = await geocode(query);                                   // Phase 2
    const [weather, forecast] = await Promise.all([                     // Phase 3
      fetchWeather(loc.lat, loc.lng),
      fetchForecast(loc.lat, loc.lng)
    ]);
    state.current = summarize(weather, loc, query);
    placeMarker(state.current);                                         // Phases 4 & 5
    renderForecast(forecast);
    favBtn.disabled = false;
    updateFavButton();
  } catch (err) {
    showAlert(err.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
}

function handleSubmit(event) {
  event.preventDefault();                  // no full-page redraw
  const query = input.value.trim();
  if (!query) {
    showAlert('Please enter a location name.');
    return;
  }
  lookupWeather(query);
}

/* ---------- Bonus: Favorites (LocalStorage) ---------- */
function loadFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG.FAVORITES_KEY) || '[]');
    state.favorites = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    state.favorites = [];
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(CONFIG.FAVORITES_KEY, JSON.stringify(state.favorites));
  } catch (_) {
    showAlert('Could not save favorites in this browser.');
  }
}

function isFavorite(city) {
  return state.favorites.some((name) => name.toLowerCase() === city.toLowerCase());
}

function updateFavButton() {
  if (!state.current) return;
  favBtn.textContent = isFavorite(state.current.city) ? '★ Saved' : '☆ Save city';
}

function renderFavorites() {
  favList.replaceChildren();
  favEmpty.hidden = state.favorites.length > 0;
  state.favorites.forEach((city) => {
    const li = document.createElement('li');
    li.className = 'fav-chip';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'fav-go';
    go.textContent = city;
    go.addEventListener('click', () => { input.value = city; lookupWeather(city); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'fav-remove';
    remove.setAttribute('aria-label', `Remove ${city} from favorites`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.favorites = state.favorites.filter((name) => name !== city);
      saveFavorites();
      renderFavorites();
      updateFavButton();
    });

    li.append(go, remove);
    favList.appendChild(li);
  });
}

function toggleFavorite() {
  if (!state.current) return;
  const city = state.current.city;
  state.favorites = isFavorite(city)
    ? state.favorites.filter((name) => name.toLowerCase() !== city.toLowerCase())
    : [...state.favorites, city];
  saveFavorites();
  renderFavorites();
  updateFavButton();
}

/* ---------- Bonus: AI chatbot (OpenAI Chat Completions) ---------- */
function addChatMessage(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-msg ${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

async function askAssistant(question) {
  requireKey(CONFIG.OPENAI_API_KEY, 'OpenAI API key');
  const context = state.current
    ? `Current weather the user is viewing: ${weatherMessage(state.current)}`
    : 'The user has not searched for a location yet.';
  const messages = [
    { role: 'system', content: `You are a concise, friendly weather assistant. Answer weather-related questions only. ${context}` },
    ...state.chatHistory.slice(-10),
    { role: 'user', content: question }
  ];
  const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: CONFIG.OPENAI_MODEL, messages, max_tokens: 300 })
  });
  const answer = data.choices[0].message.content.trim();
  state.chatHistory.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
  return answer;
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  addChatMessage('user', question);
  chatInput.value = '';
  chatSend.disabled = true;
  const pending = addChatMessage('bot', 'Thinking…');
  try {
    pending.textContent = await askAssistant(question);
  } catch (err) {
    pending.remove();
    showAlert(err.message);
  } finally {
    chatSend.disabled = false;
    chatInput.focus();
  }
}

/* ---------- Bootstrap ---------- */
function init() {
  initMap();
  loadFavorites();
  renderFavorites();
  form.addEventListener('submit', handleSubmit);
  favBtn.addEventListener('click', toggleFavorite);
  chatForm.addEventListener('submit', handleChatSubmit);
  addChatMessage('bot', 'Hi! Ask me anything about the weather.');
}

document.addEventListener('DOMContentLoaded', init);
