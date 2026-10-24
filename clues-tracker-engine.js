'use strict';

// ════════════════════════════════════════════════════════════
// MYSTERY ENGINE — the shared heart of the game
// ════════════════════════════════════════════════════════════
// One file, loaded by both packagings, mobile and web. The
// engine owns the game state and every rule of the game: it
// decides, it never draws. The packaging registers hooks with
// Engine.connect() and paints what the hooks report.

const Engine = (() => {

// ════════════════════════════════════════════════════════════
// HOOKS — how the engine speaks to the packaging
// ════════════════════════════════════════════════════════════
// connect() takes an object of functions; every one is optional,
// and the engine skips any that are not there. The hooks so far:
//   cellChanged(card, col) — this cell needs repainting
//   houseChanged(card)     — this 🏠 cell needs repainting
//   sumChanged(card)       — this ∑ cell needs repainting
//   turnChanged()          — turn, phase, or highlights changed
//   logChanged()           — the turn log gained an entry
//   setupChanged()         — the Setup view needs repainting
//   status(text, kind)     — say this; kind is 'direction' | 'warning'
// Later build pieces add hooks the same way.

let hooks = {};

function connect(h) { hooks = h || {}; }

function emit(name, ...args) {
  if (typeof hooks[name] === 'function') hooks[name](...args);
}

// ════════════════════════════════════════════════════════════
// STATE — everything the game knows, one object
// ════════════════════════════════════════════════════════════
// A cell is a list of marks. A mark is { type, turn }, plus the
// flag quit (placed by a Player Out, permanent) or house (placed
// by a 🏠 board mark) when one applies.
// Mark types: 'check' ✓, 'cross' ✗, 'asked' ?, 'showed' !,
// 'ishowed' Me.

const DEFAULT_CATEGORIES = () => {
  const make = (start, count) =>
    Array.from({ length: count }, (_, i) => 'Card ' + (start + i));
  return [
    { name: 'Category 1', cards: make(1, 9) },
    { name: 'Category 2', cards: make(10, 9) },
    { name: 'Category 3', cards: make(19, 9) }
  ];
};

function freshState() {
  return {
    categories: DEFAULT_CATEGORIES(),
    players: ['', '', '', '', '', ''],
    meSlot: -1,
    myCards: [],                                       // card names in Me's hand
    counts: { entered: false, house: 0,                // dealt-card counts from the
              players: [0, 0, 0, 0, 0, 0] },           //   "Where are the cards?" step
    cellState: {},                                     // cellState[card][col] = list of marks
    cellNotes: {},                                     // cellNotes[card + '_' + col] = short note
    sumOverrides: {},                                  // sumOverrides[card] = 'check' | 'star'
    sumTurnChanges: {},                                // sumTurnChanges[card] = the value the
                                                       //   turn began with, on the first touch
    houseChecked: {},                                  // houseChecked[card] = turn the 🏠 mark landed
    playerOutKind: {},                                 // playerOutKind[col] = 'quit' | 'wrongacc'
    activePlayers: [],
    turnCount: 1,
    turnStep: 0,
    gamePhase: 'asking',                               // 'asking' | 'showing' | 'waiting'
    pendingCards: [],
    pendingAskerCol: -1,
    lastShowerName: '',
    lastShowerCol: -1,                                 // the committed third-party shower
    lastShowCards: [],                                 // the cards that show covered
    accusationResult: null,                            // 'won' | 'lost' | 'opp:N' | null
    gameInProgress: false,
    turnLog: []
  };
}

let state = freshState();

const allCards = () => state.categories.flatMap(c => c.cards);

function ensureCell(card, col) {
  if (!state.cellState[card]) state.cellState[card] = {};
  if (!state.cellState[card][col]) state.cellState[card][col] = [];
  return state.cellState[card][col];
}

// ════════════════════════════════════════════════════════════
// MARK RULES — how marks land, hide, and leave
// ════════════════════════════════════════════════════════════
// The standing rules this section enforces:
//   1. ✓ and ✗ land once ever in a cell. ! lands once ever, and
//      only in a cell holding no ✓ and no ✗. ? and Me land once
//      per turn.
//   2. A ✓ or ✗ arriving on a cell holding a ! does not destroy
//      it: the ! stays in storage, hidden from display, and comes
//      back into view when the ✓ or ✗ is removed. A ? always
//      stays in view — the player's own trace of what was asked.
//   3. When a ✓ lands, every other active player gets ✗ for that
//      card — one hand holds it, so no other can.
//   4. Marks flagged quit are permanent: a turn wipe never
//      removes them.
// Only the engine places marks; the packaging has no door to
// placeMark. Returns true when the mark lands, false when a
// rule refuses it.

function placeMark(card, col, type, flags) {
  const quit  = !!(flags && flags.quit);
  const house = !!(flags && flags.house);
  const cell  = ensureCell(card, col);
  if ((type === 'check' || type === 'cross' || type === 'showed') &&
      cell.some(m => m.type === type)) return false;
  if (type === 'showed' &&
      cell.some(m => m.type === 'check' || m.type === 'cross')) return false;
  if ((type === 'asked' || type === 'ishowed') &&
      cell.some(m => m.type === type && m.turn === state.turnCount)) return false;
  const mark = { type, turn: state.turnCount };
  if (quit)  mark.quit  = true;
  if (house) mark.house = true;
  cell.push(mark);
  emit('cellChanged', card, col);
  // A ✓ crosses the card off for every other active player
  if (type === 'check') {
    state.activePlayers.forEach(other => {
      if (other === col) return;
      const otherCell = ensureCell(card, other);
      if (!otherCell.some(m => m.type === 'cross')) {
        const cross = { type: 'cross', turn: state.turnCount };
        if (quit) cross.quit = true;
        otherCell.push(cross);
        emit('cellChanged', card, other);
      }
    });
  }
  return true;
}

// What a cell should show. While the cell holds a ✓ or ✗, its !
// marks stay stored but are not drawn; a ? always shows. Hands
// back copies, so the caller can hold or change them without
// touching state.
function visibleMarks(card, col) {
  const cell = (state.cellState[card] && state.cellState[card][col]) || [];
  const definitive = cell.some(m => m.type === 'check' || m.type === 'cross');
  return cell
    .filter(m => !(definitive && m.type === 'showed'))
    .map(m => ({ type: m.type, turn: m.turn }));
}

// Remove one turn's marks everywhere, keeping quit-flagged marks.
// 🏠 marks from that turn leave with it.
function wipeTurn(turn) {
  allCards().forEach(card => {
    for (let col = 0; col < 6; col++) {
      const cell = state.cellState[card] && state.cellState[card][col];
      if (!cell || cell.length === 0) continue;
      const kept = cell.filter(m => m.turn !== turn || m.quit);
      if (kept.length !== cell.length) {
        state.cellState[card][col] = kept;
        emit('cellChanged', card, col);
      }
    }
  });
  Object.keys(state.houseChecked).forEach(card => {
    if (state.houseChecked[card] === turn) {
      delete state.houseChecked[card];
      emit('houseChanged', card);
    }
  });
}

// ════════════════════════════════════════════════════════════
// GAME HELPERS — small readings of the state
// ════════════════════════════════════════════════════════════

const activeCategoryCount = () =>
  state.categories.filter(c => c.cards.length > 0).length;

const getCategory = card =>
  state.categories.findIndex(c => c.cards.includes(card));

const currentCol = () =>
  state.activePlayers[state.turnStep % state.activePlayers.length];

const pName = col =>
  col === state.meSlot ? 'Me' : (state.players[col] || 'P' + (col + 1));

// Spoken-to-the-player wording: the person playing is "you"
const columnPhrase = col =>
  col === state.meSlot ? 'your column' : pName(col) + "'s column";

// Game over: an accusation verdict ended it, or no live opponent
// remains — 😢 players are not alive, and 👋 quits already left
// the active list.
function isGameOver() {
  return state.gameInProgress && (state.accusationResult !== null ||
    state.activePlayers.filter(c => c !== state.meSlot &&
      state.playerOutKind[c] !== 'wrongacc').length === 0);
}

// Answer a tap that arrives after the game has ended
function gameOverGuard() {
  if (!isGameOver()) return false;
  emit('status', 'Game over — tap New to start a new game', 'warning');
  return true;
}

function appendLog(entry) {
  state.turnLog.push(entry);
  emit('logChanged');
}

// ════════════════════════════════════════════════════════════
// SETUP — seats, deck editing, the Me hand, counts, the gate
// ════════════════════════════════════════════════════════════
// Setup fills the fresh pre-game state; play() checks the gate
// and starts the game. Every Setup door refuses while a game
// runs — New Game is the road back to Setup. Any change to the
// seats or the deck clears the entered counts: the numbers
// describe a deal that may no longer exist.

const CAP_PLAYER_NAME   = 6;
const CAP_CATEGORY_NAME = 13;
const CAP_CARD_NAME     = 13;
const MAX_CATEGORIES    = 4;
const MAX_DECK_CARDS    = 30;

const setupClosed = () => state.gameInProgress;

function clearCounts() {
  state.counts = { entered: false, house: 0, players: [0, 0, 0, 0, 0, 0] };
}

// Seats currently dealt in: the Me seat and every named player
function seatedSlots() {
  const seats = [];
  for (let i = 0; i < 6; i++) {
    if (i === state.meSlot || state.players[i].trim() !== '') seats.push(i);
  }
  return seats;
}

// One seat commit from the packaging's seat window. isMe marks
// the seat as the nameless Me seat; naming the Me seat turns it
// back into a named player. Names are trimmed and capped.
function setSeat(slot, name, isMe) {
  if (setupClosed() || slot < 0 || slot > 5) return false;
  const clean = String(name || '').trim().slice(0, CAP_PLAYER_NAME);
  const before = JSON.stringify([state.players, state.meSlot]);
  if (isMe) {
    state.meSlot = slot;
    state.players[slot] = '';
  } else {
    if (state.meSlot === slot) state.meSlot = -1;
    state.players[slot] = clean;
  }
  if (JSON.stringify([state.players, state.meSlot]) !== before) clearCounts();
  emit('setupChanged');
  save();
  return true;
}

function addCategory() {
  if (setupClosed() || state.categories.length >= MAX_CATEGORIES) return false;
  state.categories.push({
    name: 'Category ' + (state.categories.length + 1), cards: [] });
  clearCounts();
  emit('setupChanged');
  save();
  return true;
}

function deleteCategory(index) {
  if (setupClosed()) return false;
  if (state.categories.length <= 1) {
    emit('status', 'At least one category is needed', 'warning');
    return false;
  }
  const cat = state.categories[index];
  if (!cat) return false;
  cat.cards.forEach(card => {
    const i = state.myCards.indexOf(card);
    if (i >= 0) state.myCards.splice(i, 1);
  });
  state.categories.splice(index, 1);
  clearCounts();
  emit('setupChanged');
  save();
  return true;
}

// The edit window's one commit: the category's new name and its
// rows, each { orig, name } — orig null for a new row, and a
// nameless new row is dropped. Refused whole on a duplicate name
// or an overfull deck. A renamed card stays in the Me hand, a
// removed card leaves it, and an emptied category is deleted
// (keeping at least one).
function editCategory(index, catName, rows) {
  if (setupClosed()) return false;
  const cat = state.categories[index];
  if (!cat) return false;
  const entries = [];
  (rows || []).forEach(r => {
    const name = String(r.name || '').trim().slice(0, CAP_CARD_NAME);
    if (!name) return;
    entries.push({ orig: r.orig || null, name });
  });
  const otherCount = state.categories.reduce(
    (sum, c, i) => i === index ? sum : sum + c.cards.length, 0);
  if (otherCount + entries.length > MAX_DECK_CARDS) {
    emit('status', 'Maximum 30 cards total — the deck is full', 'warning');
    return false;
  }
  // Cards are known by name everywhere, so names stay unique
  // across the whole deck, case-insensitively
  const seen = new Set();
  state.categories.forEach((c, i) => {
    if (i !== index) c.cards.forEach(card => seen.add(card.toLowerCase()));
  });
  for (const e of entries) {
    const key = e.name.toLowerCase();
    if (seen.has(key)) {
      emit('status', `Duplicate card name: "${e.name}"`, 'warning');
      return false;
    }
    seen.add(key);
  }
  // Apply the name and the cards, the Me hand kept in step
  const newName = String(catName || '').trim().slice(0, CAP_CATEGORY_NAME);
  if (newName) cat.name = newName;
  const keptOrig = new Set();
  entries.forEach(e => {
    if (!e.orig) return;
    keptOrig.add(e.orig);
    const i = state.myCards.indexOf(e.orig);
    if (i >= 0 && e.name !== e.orig) state.myCards[i] = e.name;
  });
  cat.cards.forEach(card => {
    if (!keptOrig.has(card)) {
      const i = state.myCards.indexOf(card);
      if (i >= 0) state.myCards.splice(i, 1);
    }
  });
  cat.cards = entries.map(e => e.name);
  if (cat.cards.length === 0 && state.categories.length > 1)
    state.categories.splice(index, 1);
  clearCounts();
  emit('setupChanged');
  save();
  return true;
}

// A tap on a card chip: into the Me hand, or back out. The hand
// never clears the counts — picking the hand follows them.
function toggleMyCard(card) {
  if (setupClosed() || !allCards().includes(card)) return false;
  const i = state.myCards.indexOf(card);
  if (i >= 0) state.myCards.splice(i, 1);
  else state.myCards.push(card);
  emit('setupChanged');
  save();
  return true;
}

// The solution envelope (Y-10): one card per category with
// cards sits aside before any deal, so every counts door below
// works from the deck minus the envelope — never the whole
// deck.
function envelopeSize() {
  return state.categories.filter(c => c.cards.length > 0).length;
}

// The even-deal suggestion for the counts window: the House
// count is entered first, the rest of the dealt cards — the
// deck minus the envelope — splits evenly among the seated
// players, the remainder dealt one each from the first seat on
function countsPrefill(house) {
  const fill = [0, 0, 0, 0, 0, 0];
  const seats = seatedSlots();
  const rest = allCards().length - envelopeSize() - house;
  if (seats.length === 0 || house < 0 || rest < 0) return fill;
  const each = Math.floor(rest / seats.length);
  let extra = rest % seats.length;
  seats.forEach(slot => { fill[slot] = each + (extra-- > 0 ? 1 : 0); });
  return fill;
}

// The counts window's opening — the app's own reading of the
// deal (Patrick, Y-23). The seated players take an even share of
// the dealt cards — the deck minus the envelope — and House takes
// whatever is left over, which is where the spare cards sit on a
// real table. So there is always a suggestion to open on, and
// Done can accept it as it stands. This replaces the older rule,
// which put House at zero and offered nothing at all when the
// deal did not come out even.
function countsDefault() {
  const seats = seatedSlots();
  const dealt = allCards().length - envelopeSize();
  if (seats.length === 0 || dealt < 0) return null;
  const house = dealt % seats.length;
  return { house, players: countsPrefill(house) };
}

// The counts window's Done. Every dealt card must be accounted
// for: the House count and the seated players' counts must
// cover the deck minus the envelope exactly, or the whole entry
// is refused. Counts offered for empty seats are ignored.
function setCounts(house, playerCounts) {
  if (setupClosed()) return false;
  const total = allCards().length - envelopeSize();
  const clean = [0, 0, 0, 0, 0, 0];
  seatedSlots().forEach(slot => {
    clean[slot] = Number((playerCounts || [])[slot]) || 0;
  });
  const h = Number(house) || 0;
  const whole = n => Number.isInteger(n) && n >= 0;
  const sum = clean.reduce((a, b) => a + b, h);
  if (!whole(h) || !clean.every(whole) || sum !== total) {
    emit('status',
      'The number of cards entered does not equal the number of cards in your deck', 'warning');
    return false;
  }
  state.counts = { entered: true, house: h, players: clean };
  emit('setupChanged');
  save();
  return true;
}

// The Play gate: the first unmet condition in plain words, or
// null when Setup is complete — the same words on both
// packagings, in the order the Setup flow runs
function setupUnmet() {
  if (state.meSlot < 0)
    return 'You need to mark one of the seats as Me before you can play';
  if (seatedSlots().length < 2)
    return 'You need to have at least two players, counting yourself';
  const activeCats = state.categories.filter(c => c.cards.length > 0);
  if (activeCats.length < 2)
    return 'You need to have at least two categories with cards in them';
  const small = activeCats.find(c => c.cards.length < 3);
  if (small) return `You need to have at least three cards in ${small.name}`;
  if (allCards().length < 12)
    return 'You need to have at least twelve cards in your deck';
  if (!state.counts.entered)
    return 'You need to enter the card counts — tap "Where are the cards?"';
  if (state.myCards.length !== state.counts.players[state.meSlot])
    return `You need to tap ${state.counts.players[state.meSlot]} cards ` +
      `as yours — you have tapped ${state.myCards.length}`;
  return null;
}

// Play: the gate speaks, or the game starts. Starting drops the
// empty categories, seats the ring, and lays the turn-zero
// marks — a ✓ in the Me column for each card in the hand (which
// crosses it off for everyone else), an ✗ for each card not
// held — then turn 1 opens on the first seat.
function play() {
  if (state.gameInProgress) return false;
  const unmet = setupUnmet();
  if (unmet) {
    emit('status', unmet, 'warning');
    return false;
  }
  state.categories = state.categories.filter(c => c.cards.length > 0);
  state.activePlayers = seatedSlots();
  state.turnCount = 0;
  allCards().forEach(card => {
    if (state.myCards.includes(card)) placeMark(card, state.meSlot, 'check');
    else placeMark(card, state.meSlot, 'cross');
  });
  state.turnCount = 1;
  state.turnStep = 0;
  state.gamePhase = 'asking';
  state.gameInProgress = true;
  emit('turnChanged');
  save();
  return true;
}

// ════════════════════════════════════════════════════════════
// SAVED DECKS — up to four decks kept by name
// ════════════════════════════════════════════════════════════
// A saved deck is the structure only — the category names and
// their cards. Counts are set fresh every game and never saved.
// The decks live under their own key, apart from the game
// snapshot: a New Game never touches them.

const MAX_DECKS     = 4;
const CAP_DECK_NAME = 6;
let deckKey = 'mctsDecks';

function savedDecks() {
  if (!hasStorage()) return [];
  try { return JSON.parse(localStorage.getItem(deckKey)) || []; }
  catch (e) { return []; }
}

function writeDecks(decks) {
  if (!hasStorage()) return;
  try { localStorage.setItem(deckKey, JSON.stringify(decks)); } catch (e) {}
}

function saveDeck(name) {
  if (setupClosed()) return false;
  const clean = String(name || '').trim().slice(0, CAP_DECK_NAME);
  if (!clean) {
    emit('status', 'Enter a deck name first', 'warning');
    return false;
  }
  const decks = savedDecks();
  if (decks.length >= MAX_DECKS) {
    emit('status', 'Maximum 4 saved decks — delete one first', 'warning');
    return false;
  }
  if (decks.some(d => d.name.toLowerCase() === clean.toLowerCase())) {
    emit('status', 'That name is already used', 'warning');
    return false;
  }
  decks.push({ name: clean, categories:
    state.categories.map(c => ({ name: c.name, cards: [...c.cards] })) });
  writeDecks(decks);
  emit('status', `Deck "${clean}" saved`, 'direction');
  emit('setupChanged');
  return true;
}

// Loading a deck replaces the whole structure; the Me hand and
// the counts speak of cards that may be gone, so both clear
function loadDeck(index) {
  if (setupClosed()) return false;
  const deck = savedDecks()[index];
  if (!deck || !deck.categories) return false;
  state.categories = deck.categories
    .map(c => ({ name: c.name, cards: [...c.cards] }))
    .filter(c => c.cards.length > 0);
  if (state.categories.length === 0) state.categories = DEFAULT_CATEGORIES();
  state.myCards = [];
  clearCounts();
  emit('status', `Loaded "${deck.name}"`, 'direction');
  emit('setupChanged');
  save();
  return true;
}

function deleteDeck(index) {
  if (setupClosed()) return false;
  const decks = savedDecks();
  const deck = decks[index];
  if (!deck) return false;
  decks.splice(index, 1);
  writeDecks(decks);
  emit('status', `Deck "${deck.name}" deleted`, 'direction');
  emit('setupChanged');
  return true;
}

// ════════════════════════════════════════════════════════════
// TURN MACHINERY — the ring, asking, advancing, undo
// ════════════════════════════════════════════════════════════
// The packaging routes every grid-cell tap to cellTap(), the
// Next button to nextTap(), and a confirmed Undo to undoTap().
// The two-tap confirm on Undo belongs to the button, in the
// packaging.

// One cell tap. Returns true when the engine consumed it; false
// means the tap is the packaging's note-editor road.
function cellTap(card, col) {
  if (gameOverGuard()) return true;
  if (!state.activePlayers.includes(col)) return true;
  if (state.gamePhase === 'asking' && col === currentCol()) {
    askingTap(card, col);
    return true;
  }
  if (state.gamePhase === 'showing' && col === state.pendingAskerCol &&
      state.pendingCards.includes(card)) {
    takeBack(card, col);
    return true;
  }
  return false;
}

// A tap in the asker's own column: pick, unpick, or swap within
// the category. The last category's pick swings the gate to the
// showing phase.
function askingTap(card, col) {
  if (state.pendingCards.includes(card)) {
    removePick(card, col);
  } else {
    const cat = getCategory(card);
    const existing = state.pendingCards.find(c => getCategory(c) === cat);
    if (existing) removePick(existing, col);
    state.pendingCards.push(card);
    placeMark(card, col, 'asked');
  }
  if (state.pendingCards.length === activeCategoryCount()) {
    state.pendingAskerCol = col;
    state.gamePhase = 'showing';
  } else {
    askProgressStatus();
  }
  emit('turnChanged');
  save();
}

// A tap on an asked cell while the turn waits for a shower takes
// that pick back and reopens the asking phase. Once a shower is
// chosen the moment has passed — Undo is the road back.
function takeBack(card, col) {
  removePick(card, col);
  state.gamePhase = 'asking';
  state.pendingAskerCol = -1;
  askProgressStatus();
  emit('turnChanged');
  save();
}

function removePick(card, col) {
  state.pendingCards = state.pendingCards.filter(c => c !== card);
  const cell = state.cellState[card] && state.cellState[card][col];
  if (cell) {
    state.cellState[card][col] =
      cell.filter(m => !(m.type === 'asked' && m.turn === state.turnCount));
    emit('cellChanged', card, col);
  }
}

function askProgressStatus() {
  const total = activeCategoryCount();
  const missing = state.categories
    .filter(c => c.cards.length > 0 &&
      !state.pendingCards.some(p => c.cards.includes(p)))
    .map(c => c.name);
  emit('status',
    `${state.pendingCards.length}/${total} — need: ${missing.join(', ')}`,
    'direction');
}

// The Next button. In the waiting phase it advances; in the
// asking phase an empty turn passes and a half-made ask is
// refused; in the showing phase a full ask with no shower goes
// down the nobody-showed road.
function nextTap() {
  if (gameOverGuard()) return;
  if (state.gamePhase === 'waiting') {
    advanceTurn();
    return;
  }
  if (state.gamePhase === 'asking' && state.pendingCards.length > 0) {
    emit('status',
      `Select all or none of the cards in ${columnPhrase(currentCol())} first`,
      'warning');
    return;
  }
  if (state.gamePhase === 'asking') {
    appendLog({ type: 'pass', turn: state.turnCount, player: pName(currentCol()) });
    advanceTurn();
    return;
  }
  if (state.gamePhase === 'showing' &&
      state.pendingCards.length === activeCategoryCount()) {
    nobodyShowed();
  }
}

// Move the turn to the next live player, skipping 😢 players —
// they take no more turns but stay in the showing ring. The
// ending turn's settled ∑ changes log first.
function advanceTurn() {
  flushSum();
  const n = state.activePlayers.length;
  let hops = 0;
  do {
    state.turnStep = (state.turnStep + 1) % n;
    hops++;
  } while (hops < n &&
    state.playerOutKind[state.activePlayers[state.turnStep]] === 'wrongacc');
  state.turnCount++;
  state.gamePhase = 'asking';
  state.pendingCards = [];
  state.pendingAskerCol = -1;
  state.lastShowerName = '';
  state.lastShowerCol = -1;
  state.lastShowCards = [];
  emit('turnChanged');
  save();
}

// A confirmed Undo. Mid-turn it wipes the current turn; at a
// turn's very start it steps back one turn — skipping 😢
// players — and wipes that. Quit-flagged marks and ∑ marks
// stay. The undo's log entry records every hidden ! the wipe
// brought back into view, so the log can highlight the return.
function undoTap() {
  if (gameOverGuard()) return;
  const atTurnStart =
    state.gamePhase === 'asking' && state.pendingCards.length === 0;
  if (state.turnCount <= 1 && atTurnStart) {
    emit('status', 'Nothing to undo', 'warning');
    return;
  }
  const returned = [];
  wipeTurnTracking(state.turnCount, returned);
  if (atTurnStart && state.turnCount > 1) {
    state.turnCount--;
    const n = state.activePlayers.length;
    let hops = 0;
    do {
      state.turnStep = (state.turnStep - 1 + n) % n;
      hops++;
    } while (hops < n &&
      state.playerOutKind[state.activePlayers[state.turnStep]] === 'wrongacc');
    wipeTurnTracking(state.turnCount, returned);
  }
  state.gamePhase = 'asking';
  state.pendingCards = [];
  state.pendingAskerCol = -1;
  state.lastShowerName = '';
  state.lastShowerCol = -1;
  state.lastShowCards = [];
  appendLog({ type: 'undo', turn: state.turnCount, returned });
  emit('turnChanged');
  save();
}

// Wipe one turn while watching for hidden marks coming back: a
// cell that loses its last ✓ or ✗ shows its stored ! marks
// again, and each return is recorded.
function wipeTurnTracking(turn, returned) {
  const watch = [];
  allCards().forEach(card => {
    for (let col = 0; col < 6; col++) {
      const cell = state.cellState[card] && state.cellState[card][col];
      if (!cell || !cell.some(m => m.turn === turn && !m.quit)) continue;
      watch.push({ card, col, before: visibleMarks(card, col).map(m => m.type) });
    }
  });
  wipeTurn(turn);
  watch.forEach(w => {
    visibleMarks(w.card, w.col).forEach(m => {
      if (m.type === 'showed' && !w.before.includes(m.type))
        returned.push({ card: w.card, col: w.col, type: m.type });
    });
  });
}

// ════════════════════════════════════════════════════════════
// SHOWING FLOW — header taps, the guards, the shower roads
// ════════════════════════════════════════════════════════════
// The packaging routes every column-header tap to headerTap()
// and follows the road the answer names:
//   'refused' — a guard spoke; nothing changed
//   'marked'  — a third-party show committed
//   'shownme' — open the shown-to-me picker with the cards given
//   'ishowed' — open the I-showed picker with the cards given
//   'correct' — the shower's own header tapped again: after the
//               packaging's confirm-tap, call correctShower()
// The pickers confirm through confirmShownMe() and
// confirmIShowed(). Closing a picker without confirming needs no
// engine call — nothing lands until the confirm.

let modalShowerCol = -1;   // runtime only: whose header opened the shown-to-me picker

// Does this player have to show — a ✓ on any asked card? Setup
// marks count only for Me; another player's ✓ counts from the
// first real turn.
function mustShowOn(col) {
  return state.pendingCards.some(card => {
    const cell = state.cellState[card] && state.cellState[card][col];
    return cell && cell.some(m =>
      m.type === 'check' && (m.turn > 0 || col === state.meSlot));
  });
}

// The must-show-first refusal, worded in one place (Patrick,
// Y-27). Two doors reach it — tapping a player's header to say
// they showed, and tapping Next ▶ to say nobody showed — and it
// used to be typed out at both, which any later rewording could
// have left disagreeing with itself.
function mustShowFirstLine(col) {
  return col === state.meSlot
    ? 'You must show first — you have a confirmed card'
    : `${pName(col)} must show first — they have a confirmed card`;
}

function headerTap(col) {
  if (gameOverGuard()) return { road: 'refused' };
  if (!state.activePlayers.includes(col)) {
    if (state.playerOutKind[col] === 'quit')
      emit('status', `${pName(col)} has quit — they can't show`, 'warning');
    return { road: 'refused' };
  }
  if (state.gamePhase === 'asking') {
    emit('status',
      `Select ${activeCategoryCount()} cards in ${columnPhrase(currentCol())} first`,
      'warning');
    return { road: 'refused' };
  }
  if (state.gamePhase === 'waiting') {
    if (col === state.lastShowerCol && state.lastShowCards.length > 0)
      return { road: 'correct' };
    emit('status', 'Tap Next ▶ to continue', 'direction');
    return { road: 'refused' };
  }
  if (state.pendingCards.length !== activeCategoryCount())
    return { road: 'refused' };
  const askerCol = state.pendingAskerCol >= 0 ? state.pendingAskerCol : currentCol();
  // Guard 1 — the asker cannot also show
  if (col === askerCol) {
    emit('status', col === state.meSlot
      ? 'You are asking — you cannot also show'
      : `${pName(col)} is asking — cannot also show`, 'warning');
    return { road: 'refused' };
  }
  // Guard 2 — a player with ✗ on every asked card cannot show
  const askedCount = state.pendingCards.length;
  const allCrossed = state.pendingCards.every(card => {
    const cell = state.cellState[card] && state.cellState[card][col];
    return cell && cell.some(m => m.type === 'cross');
  });
  if (allCrossed) {
    emit('status', col === state.meSlot
      ? `You have ❌ on all ${askedCount} asked cards — you cannot show`
      : `${pName(col)} has ❌ on all ${askedCount} asked cards — cannot show`,
      'warning');
    return { road: 'refused' };
  }
  // Guard 3 — turn order: walking the ring from the asker, the
  // first player who must show blocks everyone after them
  const ring = state.activePlayers;
  const ai = ring.indexOf(askerCol);
  const size = ring.length;
  const colPos = (ring.indexOf(col) - ai - 1 + size) % size;
  for (let i = 1; i < size; i++) {
    const c = ring[(ai + i) % size];
    if (c === askerCol) continue;
    if (mustShowOn(c)) {
      const mustPos = (ring.indexOf(c) - ai - 1 + size) % size;
      if (colPos > mustPos) {
        emit('status', mustShowFirstLine(c), 'warning');
        return { road: 'refused' };
      }
      break;
    }
  }
  return commitShower(col, askerCol);
}

// Pick the road: Me showing goes to the I-showed picker, a show
// to Me goes to the shown-to-me picker, and a show between two
// other players commits at once. Picker card lists come back in
// deck order.
function commitShower(showerCol, askerCol) {
  if (showerCol === state.meSlot && askerCol !== state.meSlot) {
    const mine = state.pendingCards.filter(c => state.myCards.includes(c));
    return { road: 'ishowed', askerCol,
      cards: allCards().filter(c => mine.includes(c)) };
  }
  if (askerCol === state.meSlot) {
    modalShowerCol = showerCol;
    const notMine = state.pendingCards.filter(c => !state.myCards.includes(c));
    return { road: 'shownme', showerCol,
      cards: allCards().filter(c => notMine.includes(c)) };
  }
  markShower(showerCol, askerCol);
  return { road: 'marked' };
}

// A third-party show: a ! on the shower for each asked card not
// already confirmed somewhere in an earlier turn, the passers
// between asker and shower ✗-ed, the turn logged.
function markShower(showerCol, askerCol) {
  state.pendingCards.forEach(card => {
    const confirmedEarlier = state.activePlayers.some(c => {
      const cell = state.cellState[card] && state.cellState[card][c];
      return cell && cell.some(m => m.type === 'check' && m.turn < state.turnCount);
    });
    if (!confirmedEarlier) placeMark(card, showerCol, 'showed');
  });
  autoXPassers(askerCol, showerCol);
  state.lastShowerCol = showerCol;
  state.lastShowerName = pName(showerCol);
  state.lastShowCards = [...state.pendingCards];
  appendLog({ type: 'turn', turn: state.turnCount, asker: pName(askerCol),
    cards: [...state.pendingCards], result: 'showed',
    shower: pName(showerCol), shownCard: null });
  state.pendingCards = [];
  state.gamePhase = 'waiting';
  emit('turnChanged');
  save();
}

// ✗ the players walked past between asker and shower — they
// showed nothing on the asked cards
function autoXPassers(askerCol, showerCol) {
  const ring = state.activePlayers;
  const ai = ring.indexOf(askerCol);
  const si = ring.indexOf(showerCol);
  if (ai < 0 || si < 0) return;
  const size = ring.length;
  let idx = (ai + 1) % size;
  while (idx !== si) {
    const col = ring[idx];
    state.pendingCards.forEach(card => placeMark(card, col, 'cross'));
    idx = (idx + 1) % size;
  }
}

// The shown-to-me confirm: the picked card lands as a plain ✓
// in the shower's column — being shown is the only way a ✓
// lands.
function confirmShownMe(card) {
  if (state.gamePhase !== 'showing' || modalShowerCol < 0) return;
  if (!card || !state.pendingCards.includes(card)) {
    emit('status', 'Select a card', 'warning');
    return;
  }
  const showerCol = modalShowerCol;
  modalShowerCol = -1;
  placeMark(card, showerCol, 'check');
  autoXPassers(state.meSlot, showerCol);
  state.lastShowerCol = -1;
  state.lastShowerName = pName(showerCol);
  state.lastShowCards = [];
  appendLog({ type: 'turn', turn: state.turnCount, asker: pName(state.meSlot),
    cards: [...state.pendingCards], result: 'showed',
    shower: pName(showerCol), shownCard: card });
  emit('status', `${card} — shown by ${pName(showerCol)}`, 'direction');
  state.pendingCards = [];
  state.gamePhase = 'waiting';
  emit('turnChanged');
  save();
}

// The I-showed confirm: the Me mark lands in the asker's column
function confirmIShowed(card) {
  if (state.gamePhase !== 'showing' || state.pendingAskerCol < 0) return;
  if (!card || !state.pendingCards.includes(card)) {
    emit('status', 'Select a card', 'warning');
    return;
  }
  const askerCol = state.pendingAskerCol;
  placeMark(card, askerCol, 'ishowed');
  autoXPassers(askerCol, state.meSlot);
  state.lastShowerCol = -1;
  state.lastShowerName = 'Me';
  state.lastShowCards = [];
  appendLog({ type: 'turn', turn: state.turnCount, asker: pName(askerCol),
    cards: [...state.pendingCards], result: 'showed',
    shower: 'Me', shownCard: card });
  emit('status', `${card} — shown to ${pName(askerCol)}`, 'direction');
  state.pendingCards = [];
  state.gamePhase = 'waiting';
  emit('turnChanged');
  save();
}

// Take back a mis-tapped third-party show, after the packaging's
// confirm-tap: the show's ! and passer ✗ marks leave, its log
// entry leaves, and the turn reopens waiting for the right
// header. Quit and 🏠 marks are untouched.
function correctShower() {
  if (state.gamePhase !== 'waiting' || state.lastShowerCol < 0 ||
      state.lastShowCards.length === 0) return;
  const showerCol = state.lastShowerCol;
  state.lastShowCards.forEach(card => {
    for (let col = 0; col < 6; col++) {
      const cell = state.cellState[card] && state.cellState[card][col];
      if (!cell) continue;
      const kept = cell.filter(m =>
        !(m.turn === state.turnCount && !m.quit && !m.house &&
          (m.type === 'showed' || m.type === 'cross')));
      if (kept.length !== cell.length) {
        state.cellState[card][col] = kept;
        emit('cellChanged', card, col);
      }
    }
  });
  for (let i = state.turnLog.length - 1; i >= 0; i--) {
    const e = state.turnLog[i];
    if (e.type === 'turn' && e.turn === state.turnCount) {
      state.turnLog.splice(i, 1);
      emit('logChanged');
      break;
    }
  }
  state.pendingCards = [...state.lastShowCards];
  state.gamePhase = 'showing';
  state.lastShowerCol = -1;
  state.lastShowerName = '';
  state.lastShowCards = [];
  emit('status', `${pName(showerCol)}'s show taken back`, 'direction');
  emit('turnChanged');
  save();
}

// Next with a full ask and no shower: no player may be holding a
// must-show ✓; then everyone but the asker is ✗-ed on the asked
// cards and the turn moves on.
function nobodyShowed() {
  const askerCol = state.pendingAskerCol >= 0 ? state.pendingAskerCol : currentCol();
  const ring = state.activePlayers;
  const ai = ring.indexOf(askerCol);
  const size = ring.length;
  for (let i = 1; i < size; i++) {
    const c = ring[(ai + i) % size];
    if (c === askerCol) continue;
    if (mustShowOn(c)) {
      emit('status', mustShowFirstLine(c), 'warning');
      return;
    }
  }
  ring.forEach(col => {
    if (col !== askerCol)
      state.pendingCards.forEach(card => placeMark(card, col, 'cross'));
  });
  emit('status', 'No player showed — those cards are ❌-ed out for them', 'direction');
  appendLog({ type: 'turn', turn: state.turnCount, asker: pName(askerCol),
    cards: [...state.pendingCards], result: 'nobody',
    shower: null, shownCard: null });
  state.pendingCards = [];
  advanceTurn();
}

// ════════════════════════════════════════════════════════════
// ∑ AND 🏠 — the summary picker and the board column
// ════════════════════════════════════════════════════════════
// Both columns are the player's own hands at work — the engine
// keeps the books but concludes nothing. The ∑ cell holds the
// player's belief ('check' ✕ has card, 'star' ⭐ solution?, or
// clear); the packaging's picker modal commits it through
// sumCommit(), asking sumStarWarning() first so a second ⭐ in
// one category can arm the packaging's "Sure?" tap with the
// warning shown before the star lands. The 🏠 cell is a plain
// toggle through houseTap(): marking a card seen on the board
// crosses it off for every active player — bookkeeping, not
// thinking — and clearing the mark takes exactly those crosses
// back.

// The ∑ watcher's one judgment: would a ⭐ on this card make
// more than one in its category? Hands back the warning to
// speak, or null.
function sumStarWarning(card) {
  const cat = getCategory(card);
  if (cat < 0) return null;
  const crowded = state.categories[cat].cards.some(c =>
    c !== card && state.sumOverrides[c] === 'star');
  return crowded ? `More than one ⭐ in ${state.categories[cat].name}` : null;
}

// The picker's commit: 'check', 'star', or null to clear. The
// turn's first touch of a cell records what the turn began
// with, so the turn's end can log only what truly changed.
function sumCommit(card, value) {
  if (!state.gameInProgress || gameOverGuard()) return false;
  if (!allCards().includes(card)) return false;
  if (value !== 'check' && value !== 'star' && value !== null) return false;
  if (!(card in state.sumTurnChanges))
    state.sumTurnChanges[card] = state.sumOverrides[card] || null;
  if (value === null) delete state.sumOverrides[card];
  else state.sumOverrides[card] = value;
  emit('sumChanged', card);
  if (value === 'star') {
    const warning = sumStarWarning(card);
    if (warning) emit('status', warning, 'warning');
  }
  save();
  return true;
}

// The settled ∑ state goes to the log when the turn ends — and
// before an accusation or a quit is logged, so an ending never
// swallows the last changes. Cells touched but left as the turn
// found them log nothing.
function flushSum() {
  const changes = allCards()
    .filter(card => card in state.sumTurnChanges &&
      (state.sumOverrides[card] || null) !== state.sumTurnChanges[card])
    .map(card => ({ card, value: state.sumOverrides[card] || null }));
  state.sumTurnChanges = {};
  if (changes.length > 0)
    appendLog({ type: 'sum', turn: state.turnCount, changes });
}

// The 🏠 toggle. Marking: the card was seen on the board, so no
// hand holds it — every other active player is crossed off,
// each ✗ flagged house so the clearing can find them. Me needs
// no cross: the Me column crossed off every unheld card when
// the game started. Clearing: the mark, exactly its crosses,
// and its log entry from the current turn leave; an earlier
// turn's entry stays as history.
function houseTap(card) {
  if (!state.gameInProgress || gameOverGuard()) return false;
  if (!allCards().includes(card)) return false;
  if (state.houseChecked[card] !== undefined) {
    delete state.houseChecked[card];
    for (let col = 0; col < 6; col++) {
      const cell = state.cellState[card] && state.cellState[card][col];
      if (!cell) continue;
      const kept = cell.filter(m => !(m.type === 'cross' && m.house));
      if (kept.length !== cell.length) {
        state.cellState[card][col] = kept;
        emit('cellChanged', card, col);
      }
    }
    for (let i = state.turnLog.length - 1; i >= 0; i--) {
      const e = state.turnLog[i];
      if (e.type === 'house' && e.card === card && e.turn === state.turnCount) {
        state.turnLog.splice(i, 1);
        emit('logChanged');
        break;
      }
    }
    emit('status', `${card} board mark cleared`, 'direction');
  } else {
    state.houseChecked[card] = state.turnCount;
    state.activePlayers.forEach(col => {
      if (col !== state.meSlot) placeMark(card, col, 'cross', { house: true });
    });
    appendLog({ type: 'house', turn: state.turnCount, card });
    emit('status', `${card} is on the board`, 'direction');
  }
  emit('houseChanged', card);
  save();
  return true;
}

// ════════════════════════════════════════════════════════════
// CELL NOTES — the player's own short reminders
// ════════════════════════════════════════════════════════════
// A note is the player's own hand at work, like ∑ — the engine
// stores it and concludes nothing. The packaging's note modal is
// the one door: setCellNote commits (an empty text clears the
// note), and cellNote reads it back for painting. Notes are
// never logged, and a turn wipe never touches them.

const CAP_NOTE = 4;

function cellNote(card, col) {
  return state.cellNotes[card + '_' + col] || '';
}

function setCellNote(card, col, text) {
  if (!state.gameInProgress || gameOverGuard()) return false;
  if (!allCards().includes(card) || col < 0 || col > 5) return false;
  const clean = String(text || '').trim().slice(0, CAP_NOTE);
  if (clean) state.cellNotes[card + '_' + col] = clean;
  else delete state.cellNotes[card + '_' + col];
  emit('cellChanged', card, col);
  save();
  return true;
}

// ════════════════════════════════════════════════════════════
// ENDINGS AND EXITS — accusation, Player Out, New Game
// ════════════════════════════════════════════════════════════
// The packaging opens its own modals; nothing lands until the
// one commit call, and the two-tap confirms belong to the
// packaging's buttons. Accusation: accuse() takes the accuser,
// the picked cards, and the verdict — no verdict can ever be
// undone. Player Out: playerOutCards() hands the quit picker its
// card list, playerOut() commits the quit. New Game: newGame()
// resets the state under the two keep choices.

// An accusation verdict. result is 'right' or 'wrong'. Your
// verdict ends the game either way; an opponent's right verdict
// ends it as their win; an opponent's wrong one sends them to
// the permanent 😢 sideline and the game plays on. Returns true
// when the verdict lands, false when a guard refuses it.
function accuse(col, cards, result) {
  if (gameOverGuard()) return false;
  if (!state.activePlayers.includes(col)) {
    emit('status', 'Select who is accusing first', 'warning');
    return false;
  }
  if (state.playerOutKind[col] === 'wrongacc') {
    emit('status', `${pName(col)} is already out on a wrong accusation`, 'warning');
    return false;
  }
  // The accusation must name one card from every category with cards
  const picked = allCards().filter(c => (cards || []).includes(c));  // deck order
  const covered = state.categories.filter(cat =>
    picked.some(c => cat.cards.includes(c))).length;
  if (picked.length !== activeCategoryCount() ||
      covered !== activeCategoryCount()) {
    emit('status', `Select the ${activeCategoryCount()} cards accused first`, 'warning');
    return false;
  }
  flushSum();
  appendLog({ type: 'accuse', turn: state.turnCount, accuser: pName(col),
    cards: picked, result });
  if (col === state.meSlot) {
    state.accusationResult = result === 'right' ? 'won' : 'lost';
  } else if (result === 'right') {
    state.accusationResult = 'opp:' + col;
  } else {
    state.playerOutKind[col] = 'wrongacc';
    if (isGameOver()) {
      emit('status', `${pName(col)}'s accusation was wrong — game over, you won`,
        'direction');
    } else {
      emit('status', `${pName(col)}'s accusation was wrong`, 'direction');
      // The turn-holder going out passes the turn on at once,
      // whatever state their turn was in: a standing ask is
      // abandoned and leaves no trace — its picks' ? marks come
      // off, as the take-back road does — and a finished show
      // needs no Next. advanceTurn clears the mid-turn state.
      if (state.gameInProgress && currentCol() === col) {
        [...state.pendingCards].forEach(card => removePick(card, col));
        advanceTurn();
        return true;
      }
    }
  }
  emit('turnChanged');
  save();
  return true;
}

// The quit picker's card list, in deck order. A card already
// ✓-confirmed in another column cannot be in this player's hand:
// its holder is named so the packaging can fade it dead.
function playerOutCards(col) {
  return allCards().map(card => {
    let holder = null;
    for (let c = 0; c < 6; c++) {
      if (c === col) continue;
      const cell = state.cellState[card] && state.cellState[card][c];
      if (cell && cell.some(m => m.type === 'check')) { holder = pName(c); break; }
    }
    return { card, holder };
  });
}

// The 👋 quit commit: the shown cards land as permanent ✓ marks,
// the rest of the column is permanently ✗-ed — their hidden cards
// left the game — and the player leaves the ring. Picking no
// shown cards is legal. Returns true when the quit lands.
function playerOut(col, shownCards) {
  if (gameOverGuard()) return false;
  if (col === state.meSlot || !state.activePlayers.includes(col)) {
    emit('status', 'Select a player first', 'warning');
    return false;
  }
  // Drop any pick a ✓ elsewhere makes impossible
  const legal = playerOutCards(col).filter(e => !e.holder).map(e => e.card);
  const shown = allCards().filter(c =>
    (shownCards || []).includes(c) && legal.includes(c));
  const heldTurn = state.gameInProgress && currentCol() === col;
  shown.forEach(card => placeMark(card, col, 'check', { quit: true }));
  allCards().forEach(card => {
    const cell = state.cellState[card] && state.cellState[card][col];
    if (!cell || !cell.some(m => m.type === 'check' || m.type === 'cross'))
      placeMark(card, col, 'cross', { quit: true });
  });
  state.playerOutKind[col] = 'quit';
  flushSum();
  appendLog({ type: 'out', turn: state.turnCount, player: pName(col), cards: shown });
  removeFromRing(col);
  emit('status', isGameOver()
    ? `${pName(col)} has left the game — game over, you won`
    : `${pName(col)} has left the game`, 'direction');
  // A clean turn-holder quitting ends their turn; the removal
  // already points at the next player
  if (heldTurn && state.gamePhase === 'asking' &&
      state.pendingCards.length === 0 && state.activePlayers.length > 0) {
    state.turnCount++;
  }
  emit('turnChanged');
  save();
  return true;
}

// Take a player out of the ring with the turn-pointer care: a
// quit on someone else's turn must not move the turn, and the
// pointer must never land on a 😢 player.
function removeFromRing(col) {
  const cur = currentCol();  // whose turn it is, before the line-up shifts
  state.activePlayers = state.activePlayers.filter(c => c !== col);
  const n = state.activePlayers.length;
  if (state.turnStep >= n) state.turnStep = 0;
  if (cur !== col && state.activePlayers.includes(cur))
    state.turnStep = state.activePlayers.indexOf(cur);
  let hops = 0;
  while (n > 0 && hops < n &&
    state.playerOutKind[state.activePlayers[state.turnStep]] === 'wrongacc') {
    state.turnStep = (state.turnStep + 1) % n;
    hops++;
  }
}

// A confirmed New Game: everything starts fresh except what the
// two choices keep — the seats, the deck, and the counts' numbers
// when both of those are kept. The numbers belong to the group and
// its deck rather than to the deal: the same people playing the
// same deck put the same number of cards in the same places, and
// they carry how that table plays — spares in a house, or dealt
// round the players — which no guess can know on its own.
// What does not carry is the settled flag (Patrick, Y-23,
// correcting Y-22): the numbers come back filled in, but the
// counts window waits for Done before the game counts them
// answered for. Either choice taken New clears them, since a
// changed seating or a changed deck describes a game the old
// counts no longer fit. The hand never carries — a fresh shuffle
// really does put different cards in it. No game-over guard here:
// New Game is the one door out of an ended game.
function newGame(keepPlayers, keepDeck) {
  const kept = {};
  if (keepPlayers) {
    kept.players = [...state.players];
    kept.meSlot = state.meSlot;
  }
  if (keepDeck) {
    kept.categories = state.categories.map(c =>
      ({ name: c.name, cards: [...c.cards] }));
  }
  if (keepPlayers && keepDeck) {
    kept.counts = { entered: false,
                    house: state.counts.house,
                    players: [...state.counts.players] };
  }
  state = Object.assign(freshState(), kept);
  emit('turnChanged');
  emit('logChanged');
  save();
}

// ════════════════════════════════════════════════════════════
// LOG RENDERER — the shared words the packagings paint
// ════════════════════════════════════════════════════════════
// The engine words the log; the packaging paints it. logView()
// hands back everything the log page needs: the live "Now" line
// (null when no game runs), the shared empty-state line, and the
// entries newest-first — each worded as a title and detail
// lines, labeled with its kind so the packaging can style one
// block per kind. A line carries highlight: true when the log
// must call attention to it — the return of a hidden ! or ?
// after an undo. Wording law: players by name, and the person
// playing is "you," never "Me".

const sayName = name => name === 'Me' ? 'You' : name;

function line(text, highlight) { return { text, highlight: !!highlight }; }

function wordEntry(e) {
  if (e.type === 'turn') {
    const lines = [line(e.cards.join(', '))];
    lines.push(e.result === 'nobody'
      ? line('Nobody showed.')
      : line(`${sayName(e.shower)} showed${e.shownCard ? ' ' + e.shownCard : ''}`));
    return { kind: 'turn',
      title: `Turn ${e.turn} — ${sayName(e.asker)} asked`, lines };
  }
  if (e.type === 'pass') {
    return { kind: 'pass',
      title: `Turn ${e.turn} — ${sayName(e.player)} didn't get a chance to ask`,
      lines: [] };
  }
  if (e.type === 'accuse') {
    const who = sayName(e.accuser);
    const verdict = who === 'You'
      ? (e.result === 'right' ? 'Right — you won the game.'
                              : 'Wrong — you lost the game.')
      : (e.result === 'right' ? `Right — ${who} won the game.`
                              : `Wrong — ${who} is out on a wrong accusation. 😢`);
    return { kind: 'accuse', title: `Turn ${e.turn} — ⭐ ${who} accused`,
      lines: [line(e.cards.join(', ')), line(verdict)] };
  }
  if (e.type === 'sum') {
    const label = v =>
      v === 'check' ? '✕ Has card' : v === 'star' ? '⭐ Solution?' : 'Cleared';
    return { kind: 'sum', title: `Turn ${e.turn} — ∑ changed`,
      lines: e.changes.map(c => line(`${c.card} — ${label(c.value)}`)) };
  }
  if (e.type === 'house') {
    return { kind: 'house',
      title: `Turn ${e.turn} — 🏠 ${e.card} is on the board`, lines: [] };
  }
  if (e.type === 'out') {
    return { kind: 'out', title: `Turn ${e.turn} — 👋 ${sayName(e.player)} quit`,
      lines: [line(e.cards.length > 0
        ? `Showed on the way out: ${e.cards.join(', ')}`
        : 'Showed no cards.')] };
  }
  // e.type === 'undo' — only the ! ever hides, so only it returns
  const lines = [line(`All Turn ${e.turn} marks removed.`)];
  e.returned.forEach(r => {
    lines.push(line(
      `The hidden ! on ${r.card} in ${columnPhrase(r.col)} is back.`, true));
  });
  return { kind: 'undo', title: `Turn ${e.turn} — ↩ Undo — turn restarted`, lines };
}

// The live "Now" line: the game's present moment in one sentence
function nowLine() {
  if (!state.gameInProgress) return null;
  if (state.accusationResult === 'won')  return 'Game over — you won!';
  if (state.accusationResult === 'lost') return 'Game over — you lost.';
  if (state.accusationResult !== null && String(state.accusationResult).startsWith('opp:'))
    return `Game over — ${pName(Number(state.accusationResult.slice(4)))} won.`;
  if (isGameOver()) return 'Game over — you won';
  if (state.gamePhase === 'waiting')
    return `Now — ${sayName(state.lastShowerName)} showed — tap Next ▶`;
  if (state.gamePhase === 'showing')
    return 'Now — waiting for someone to show';
  const col = currentCol();
  return col === state.meSlot
    ? 'Now — your turn to ask'
    : `Now — ${pName(col)}'s turn to ask`;
}

function logView() {
  return {
    now: nowLine(),
    empty: 'No turns logged yet.',
    entries: [...state.turnLog].reverse().map(wordEntry)
  };
}

// ════════════════════════════════════════════════════════════
// PERSISTENCE — one snapshot, one key
// ════════════════════════════════════════════════════════════
// The whole state saves as one record under one key. Saved games
// from the shipped apps use other keys and are never read: the
// rebuilt app starts fresh. In the mobile wrapper the native
// side mirrors localStorage on its own; the engine just writes.
// Where no localStorage exists, saving and loading quietly do
// nothing.

const SCHEMA = 1;
let storageKey = 'mctsGame';

function hasStorage() { return typeof localStorage !== 'undefined'; }

function save() {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ schema: SCHEMA, state }));
  } catch (e) {}
}

// Load the saved snapshot, if one exists. Missing fields take
// their defaults, so a snapshot from an older build still loads.
function boot() {
  if (!hasStorage()) return;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && data.schema === SCHEMA && data.state)
      state = Object.assign(freshState(), data.state);
  } catch (e) {}
}

// ════════════════════════════════════════════════════════════
// TEST DOOR — for the test harness and the visual test driver
// ════════════════════════════════════════════════════════════
// inspect() hands back a deep copy of the whole state: read
// anything, break nothing. The testing object arranges scenarios
// and reaches the internal machinery, so every rule can be
// tested directly and a visual driver can walk the real app
// into any state.

function inspect() { return JSON.parse(JSON.stringify(state)); }

const testing = {
  // Fresh defaults with the given fields laid over, then saved
  reset(fields) {
    state = Object.assign(freshState(), fields || {});
    save();
  },
  setTurn(turn) { state.turnCount = turn; },
  useStorageKey(key) { storageKey = key; },
  useDeckKey(key) { deckKey = key; },
  placeMark,
  wipeTurn
};

return { connect, boot, visibleMarks, cellTap, headerTap, nextTap, undoTap,
  confirmShownMe, confirmIShowed, correctShower,
  accuse, playerOutCards, playerOut, newGame, logView, inspect, testing,
  setSeat, addCategory, deleteCategory, editCategory, toggleMyCard,
  envelopeSize, countsPrefill, countsDefault, setCounts, setupUnmet, play,
  savedDecks, saveDeck, loadDeck, deleteDeck,
  sumCommit, sumStarWarning, houseTap, setCellNote, cellNote };

})();

// The engine's one global name, in a page or in a test runner
if (typeof window !== 'undefined') window.Engine = Engine;
else globalThis.Engine = Engine;
