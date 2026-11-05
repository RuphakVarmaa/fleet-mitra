// Demo data inserted the first time the app opens (and after "Reset demo data").
// Every seeded account uses the password "demo1234". Every email uses the .test domain.
// Dates are fixed in Oct/Nov 2026 so the board always looks the same.

export const DEMO_PASSWORD = 'demo1234';

export const SEED_USERS = [
  { key: 'admin',  name: 'Fleet Mitra Admin', email: 'admin@fleetmitra.test',  role: 'admin', created_at: '2026-10-20T09:00:00.000Z' },
  { key: 'demo',   name: 'Fleet Mitra demo',  email: 'demo@fleetmitra.test',   role: 'user',  created_at: '2026-10-20T09:05:00.000Z' },
  { key: 'owner',  name: 'Sample Owner',      email: 'owner@fleetmitra.test',  role: 'user',  created_at: '2026-10-21T10:30:00.000Z' },
  { key: 'finder', name: 'Sample Finder',     email: 'finder@fleetmitra.test', role: 'user',  created_at: '2026-10-21T11:10:00.000Z' },
];

// Shown in the sign-in dialog so a visitor can fill the form with one click.
export const DEMO_ACCOUNTS = [
  { email: 'owner@fleetmitra.test',  name: 'Sample Owner',      hint: 'Lost the steel water bottle' },
  { email: 'finder@fleetmitra.test', name: 'Sample Finder',     hint: 'Found a bottle in the library' },
  { email: 'admin@fleetmitra.test',  name: 'Fleet Mitra Admin', hint: 'Opens the admin dashboard' },
  { email: 'demo@fleetmitra.test',   name: 'Fleet Mitra demo',  hint: 'Owns the Demo listings' },
];

// owner = key from SEED_USERS. Demo listings (is_demo = 1) can't receive claims.
export const SEED_ITEMS = [
  {
    owner: 'demo', is_demo: 1, type: 'found', status: 'open', category: 'Other',
    title: 'Black folding umbrella',
    description: 'Compact black umbrella with a hooked wooden handle, left on a bench at the bus bay after the evening rain.',
    location: 'Bus bay', event_date: '2026-10-29',
    question: 'What is written on the strap?', answer: 'fleet',
    created_at: '2026-10-29T12:40:00.000Z',
  },
  {
    owner: 'demo', is_demo: 1, type: 'lost', status: 'open', category: 'Electronics',
    title: 'Scientific calculator (fx-991)',
    description: 'Grey fx-991 calculator in a black slide cover, last used during the afternoon exam in hall B.',
    location: 'Exam hall B', event_date: '2026-10-30',
    question: 'What name is scratched on the back?', answer: 'arun',
    created_at: '2026-10-30T11:20:00.000Z',
  },
  {
    owner: 'demo', is_demo: 1, type: 'found', status: 'open', category: 'Keys',
    title: 'Hostel room key with red ring',
    description: 'Single brass key on a red plastic ring with a small numbered tag, handed in at the hostel gate.',
    location: 'Hostel gate', event_date: '2026-10-28',
    question: 'What number is on the tag?', answer: '214',
    created_at: '2026-10-28T16:05:00.000Z',
  },
  {
    owner: 'demo', is_demo: 1, type: 'lost', status: 'open', category: 'Documents',
    title: 'College ID card holder',
    description: 'Transparent ID card holder on a blue lanyard with a bus pass tucked behind the card.',
    location: 'Main canteen', event_date: '2026-10-31',
    question: 'What colour is the lanyard print?', answer: 'white',
    created_at: '2026-10-31T08:45:00.000Z',
  },
  {
    owner: 'demo', is_demo: 1, type: 'lost', status: 'open', category: 'Bags & wallets',
    title: 'Brown leather wallet',
    description: 'Bi-fold brown leather wallet with a worn corner, dropped somewhere in the auditorium during the cultural meet.',
    location: 'Auditorium', event_date: '2026-10-30',
    question: 'What is inside the coin pocket?', answer: 'a temple token',
    created_at: '2026-10-30T18:15:00.000Z',
  },
  {
    owner: 'demo', is_demo: 1, type: 'found', status: 'returned', category: 'Clothing',
    title: 'Navy blue lab coat',
    description: 'Navy blue lab coat, size M, found on a stool in the chemistry lab after the practical session.',
    location: 'Chemistry lab', event_date: '2026-10-27',
    question: 'What initials are stitched on the pocket?', answer: 'kr',
    created_at: '2026-10-27T14:30:00.000Z',
  },
  // The real sample pair used for the live demo (is_demo = 0, so it can be claimed).
  {
    owner: 'owner', is_demo: 0, type: 'lost', status: 'open', category: 'Other',
    title: 'Silver steel water bottle',
    description: '1-litre steel bottle with a dent near the base, left at a reading desk.',
    location: 'Library first floor', event_date: '2026-11-02',
    question: 'What sticker is on the bottle?', answer: 'rocket',
    created_at: '2026-11-02T10:10:00.000Z',
  },
  {
    owner: 'finder', is_demo: 0, type: 'found', status: 'open', category: 'Other',
    title: 'Steel bottle with stickers',
    description: 'Found a steel bottle with a few stickers on a library desk.',
    location: 'Library first floor', event_date: '2026-11-02',
    question: 'What colour is the cap?', answer: 'black',
    created_at: '2026-11-02T13:25:00.000Z',
  },
];
