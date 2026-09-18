// Anmeldeseite für die Automaten-Karte – sammelt Kundendaten und leitet für
// IBAN + SEPA-Mandat sicher zu Stripe (Checkout im "setup"-Modus, kein Sofort-Einzug).
// Nach erfolgreicher Anmeldung wird der Kunde automatisch in K-Box (GleeBees) angelegt.
// (Flache Version: HTML-Dateien liegen im selben Ordner wie server.js.)
const express = require('express');
const path = require('path');
const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) { console.error('FEHLER: STRIPE_SECRET_KEY ist nicht gesetzt (siehe env.example).'); process.exit(1); }
const stripe = Stripe(KEY);

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const app = express();
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// K-Box / GleeBees – Konfiguration
// ---------------------------------------------------------------------------
const KBOX_BASE = 'https://api.k-box.io';

// Auswahlwert im Formular  ->  K-Box-Organisation + zugehörige Zugangsdaten (aus den Render-Umgebungsvariablen).
// Achtung: BAT heißt in K-Box weiterhin "Nexans Hof".
const FIRMEN = {
  'BWF':         { org: 'BWF Hof',       appId: process.env.KBOX_BWF_APPID,         apiKey: process.env.KBOX_BWF_APIKEY },
  'BAT':         { org: 'Nexans Hof',    appId: process.env.KBOX_BAT_APPID,         apiKey: process.env.KBOX_BAT_APIKEY },
  'Rettenmeier': { org: 'Rettenmeier',   appId: process.env.KBOX_RETTENMEIER_APPID, apiKey: process.env.KBOX_RETTENMEIER_APIKEY },
  'Sommer':      { org: 'Sommer Döhlau', appId: process.env.KBOX_SOMMER_APPID,      apiKey: process.env.KBOX_SOMMER_APIKEY },
  'Südleder':    { org: 'Südleder',      appId: process.env.KBOX_SUEDLEDER_APPID,   apiKey: process.env.KBOX_SUEDLEDER_APIKEY },
};

// Nachschlage-Tabelle Kartennummer -> lange NFC Id (aus der als CSV veröffentlichten
// Google-Tabelle "Mampfkarten ID"). URL kommt aus der Umgebungsvariable KARTEN_CSV_URL.
// Wird 10 Minuten zwischengespeichert, damit neue Karten-Batches schnell wirken.
let kartenCache = { map: null, ts: 0 };
async function ladeKartenMap() {
  const raw = process.env.KARTEN_CSV_URL;
  if (!raw) return null;
  // Mehrere CSV-Links (ein Reiter je Link) können mit Komma getrennt angegeben werden.
  const urls = raw.split(',').map(u => u.trim()).filter(Boolean);
  if (!urls.length) return null;
  const now = Date.now();
  if (kartenCache.map && (now - kartenCache.ts) < 10 * 60 * 1000) return kartenCache.map;
  const map = new Map();
  for (const u of urls) {
    const resp = await fetch(u);
    if (!resp.ok) throw new Error('CSV-Abruf fehlgeschlagen: HTTP ' + resp.status);
    const text = await resp.text();
    for (const line of text.split(/\r?\n/)) {
      const cols = line.split(',');
      if (cols.length < 2) continue;
      const nr = (cols[0] || '').trim().replace(/^"|"$/g, '').replace(/\.0+$/, '');
      // NFC Id als Text behalten (die Zahlen sind zu groß für JS-Zahlen) und Ziffern herausfiltern.
      const id = (cols[1] || '').trim().replace(/^"|"$/g, '').replace(/[^0-9]/g, '');
      if (!/^\d+$/.test(nr)) continue;   // Kopf-/Leerzeilen überspringen
      if (!id) continue;                 // fehlende/fehlerhafte NFC Id überspringen
      map.set(nr, id);
    }
  }
  kartenCache = { map, ts: now };
  return map;
}

// Legt den Kunden in K-Box an – aber nur, wenn er dort noch nicht existiert.
async function kboxAnlegen({ kartennummer, firmaKey, name, email }) {
  const firma = FIRMEN[firmaKey];
  if (!firma) return { status: 'firma_unbekannt', firmaKey };
  if (!firma.appId || !firma.apiKey) return { status: 'firma_kein_key', org: firma.org };

  const map = await ladeKartenMap();
  if (!map) return { status: 'keine_tabelle' };
  const nfcId = map.get(String(kartennummer || '').trim());
  if (!nfcId) return { status: 'nummer_unbekannt', kartennummer };

  const headers = { 'ErpAppId': firma.appId, 'ErpApiKey': firma.apiKey, 'Content-Type': 'application/json' };

  // 1) Existiert die Karte schon? -> Bestandskunde, nichts anlegen.
  const check = await fetch(`${KBOX_BASE}/customers/${encodeURIComponent(nfcId)}`, { headers });
  if (check.ok) return { status: 'bestandskunde', nfcId, org: firma.org };
  if (check.status !== 404) {
    const detail = await check.text().catch(() => '');
    return { status: 'fehler_pruefung', code: check.status, detail, nfcId, org: firma.org };
  }

  // 2) Neukunde -> anlegen.
  const body = JSON.stringify({ nfcId: nfcId, name: name, mail: email });
  const create = await fetch(`${KBOX_BASE}/customers`, { method: 'POST', headers, body });
  if (create.ok) return { status: 'neu_angelegt', nfcId, org: firma.org };
  const detail = await create.text().catch(() => '');
  return { status: 'fehler_anlegen', code: create.status, detail, nfcId, org: firma.org };
}

// ---------------------------------------------------------------------------
// Startseite und Logo direkt ausliefern
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logo.png', (_req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

// Registrierung entgegennehmen -> Stripe-Kunde anlegen -> zu Stripe (SEPA-Mandat) weiterleiten
app.post('/register', async (req, res) => {
  try {
    const b = req.body || {};
    const firma = (b.firma || '').trim();
    const email = (b.email || '').trim();
    const kartennummer = (b.kartennummer || '').trim();
    const arbeitgeber = (b.arbeitgeber || '').trim();

    if (!firma || !email || !kartennummer || !arbeitgeber) {
      return res.status(400).send('Bitte Firma/Name, E-Mail, Kartennummer und Firma/Arbeitgeber ausfüllen.');
    }

    const customer = await stripe.customers.create({
      name: firma,
      email: email,
      phone: (b.telefon || '').trim() || undefined,
      address: {
        line1: (b.strasse || '').trim() || undefined,
        postal_code: (b.plz || '').trim() || undefined,
        city: (b.ort || '').trim() || undefined,
        country: 'DE',
      },
      metadata: {
        ansprechpartner: (b.ansprechpartner || '').trim(),
        nfc_kartennummer: kartennummer,
        arbeitgeber: arbeitgeber,
        standort: (b.standort || '').trim(),
        quelle: 'Automaten-Registrierung',
      },
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      payment_method_types: ['sepa_debit'],
      customer: customer.id,
      locale: 'de',
      success_url: `${BASE_URL}/erfolg?cs={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?abgebrochen=1`,
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error(err);
    return res.status(500).send('Es ist ein Fehler aufgetreten: ' + err.message);
  }
});

// Erfolgsseite: gespeicherte Bankverbindung als Standard setzen + Kunde automatisch in K-Box anlegen
app.get('/erfolg', async (req, res) => {
  try {
    const cs = req.query.cs;
    if (cs) {
      const session = await stripe.checkout.sessions.retrieve(cs);
      if (session && session.customer) {
        // 1) SEPA-Zahlungsmethode als Standard für künftige Rechnungen setzen
        if (session.setup_intent) {
          const si = await stripe.setupIntents.retrieve(session.setup_intent);
          if (si && si.payment_method) {
            await stripe.customers.update(session.customer, {
              invoice_settings: { default_payment_method: si.payment_method },
            });
          }
        }

        // 2) Kunde automatisch in K-Box anlegen (nur Neukunden), fehlertolerant
        try {
          const cust = await stripe.customers.retrieve(session.customer);
          const md = (cust && cust.metadata) || {};
          if (md.quelle === 'Automaten-Registrierung' && md.karte_kbox !== 'ja') {
            const kName = ((md.ansprechpartner || cust.name || '').trim() + ' ' + (md.nfc_kartennummer || '').trim()).trim();
            const result = await kboxAnlegen({
              kartennummer: md.nfc_kartennummer,
              firmaKey: md.arbeitgeber,
              name: kName,
              email: cust.email,
            });
            console.log('K-Box Ergebnis:', JSON.stringify(result));
            // Bei Erfolg merken, damit ein erneuter Seitenaufruf nichts doppelt macht.
            if (result.status === 'neu_angelegt' || result.status === 'bestandskunde') {
              await stripe.customers.update(session.customer, {
                metadata: { karte_kbox: 'ja', karte_kbox_status: result.status },
              }).catch(() => {});
            } else {
              await stripe.customers.update(session.customer, {
                metadata: { karte_kbox_status: result.status },
              }).catch(() => {});
            }
          }
        } catch (e) {
          console.error('K-Box-Anlage fehlgeschlagen (nicht kritisch):', e.message);
        }
      }
    }
  } catch (err) {
    console.error('Hinweis (nicht kritisch):', err.message);
  }
  res.sendFile(path.join(__dirname, 'erfolg.html'));
});

app.get('/gesundheit', (_req, res) => res.send('ok'));

// Diagnose: prüft NUR die K-Box-Anmeldung für eine Firma + Kartennummer (legt nichts an).
// Beispiel: /kbox-test?firma=Sommer&nummer=4928 . Gibt keine Schlüssel preis, nur deren Länge.
app.get('/kbox-test', async (req, res) => {
  try {
    const firmaKey = (req.query.firma || '').trim();
    const kartennummer = (req.query.nummer || '').trim();
    const firma = FIRMEN[firmaKey];
    if (!firma) return res.json({ status: 'firma_unbekannt', firmaKey });
    const appIdLen = (firma.appId || '').length;
    const apiKeyLen = (firma.apiKey || '').length;
    if (!firma.appId || !firma.apiKey) return res.json({ status: 'firma_kein_key', org: firma.org, appIdLen, apiKeyLen });
    const map = await ladeKartenMap();
    if (!map) return res.json({ status: 'keine_tabelle' });
    const nfcId = map.get(String(kartennummer).trim());
    if (!nfcId) return res.json({ status: 'nummer_unbekannt', kartennummer });
    const headers = { 'ErpAppId': firma.appId, 'ErpApiKey': firma.apiKey };
    const r = await fetch(`${KBOX_BASE}/customers/${encodeURIComponent(nfcId)}`, { headers });
    const detail = await r.text().catch(() => '');
    const status = r.ok ? 'auth_ok_karte_existiert' : (r.status === 404 ? 'auth_ok_karte_neu' : 'fehler');
    return res.json({ status, code: r.status, detail, nfcId, org: firma.org, appIdLen, apiKeyLen });
  } catch (e) {
    return res.json({ status: 'exception', message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Anmeldeseite läuft auf Port ${PORT} (BASE_URL: ${BASE_URL})`));
