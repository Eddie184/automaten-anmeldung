// Anmeldeseite für die Automaten-Karte – sammelt Kundendaten und leitet für
// IBAN + SEPA-Mandat sicher zu Stripe (Checkout im "setup"-Modus, kein Sofort-Einzug).
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

// Startseite und Logo direkt ausliefern
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
      return res.status(400).send('Bitte Firma/Name, E-Mail, Kartennummer und Arbeitgeber ausfüllen.');
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

// Erfolgsseite: gespeicherte Bankverbindung als Standard für künftige Rechnungen setzen
app.get('/erfolg', async (req, res) => {
  try {
    const cs = req.query.cs;
    if (cs) {
      const session = await stripe.checkout.sessions.retrieve(cs);
      if (session && session.setup_intent && session.customer) {
        const si = await stripe.setupIntents.retrieve(session.setup_intent);
        if (si && si.payment_method) {
          await stripe.customers.update(session.customer, {
            invoice_settings: { default_payment_method: si.payment_method },
          });
        }
      }
    }
  } catch (err) {
    console.error('Hinweis (nicht kritisch):', err.message);
  }
  res.sendFile(path.join(__dirname, 'erfolg.html'));
});

app.get('/gesundheit', (_req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Anmeldeseite läuft auf Port ${PORT} (BASE_URL: ${BASE_URL})`));
