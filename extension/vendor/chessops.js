var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/chessops/dist/esm/types.js
var FILE_NAMES = ["a", "b", "c", "d", "e", "f", "g", "h"];
var RANK_NAMES = ["1", "2", "3", "4", "5", "6", "7", "8"];
var ROLE_CHARS = ["q", "n", "r", "b", "p", "k"];
var COLORS = ["white", "black"];
var ROLES = ["pawn", "knight", "bishop", "rook", "queen", "king"];
var CASTLING_SIDES = ["a", "h"];
var isDrop = (v) => "role" in v;
var isNormal = (v) => "from" in v;

// node_modules/chessops/dist/esm/util.js
var defined = (v) => v !== void 0;
var opposite = (color) => color === "white" ? "black" : "white";
var squareRank = (square2) => square2 >> 3;
var squareFile = (square2) => square2 & 7;
var squareFromCoords = (file, rank) => 0 <= file && file < 8 && 0 <= rank && rank < 8 ? file + 8 * rank : void 0;
var roleToChar = (role) => {
  switch (role) {
    case "pawn":
      return "p";
    case "knight":
      return "n";
    case "bishop":
      return "b";
    case "rook":
      return "r";
    case "queen":
      return "q";
    case "king":
      return "k";
  }
};
function charToRole(ch) {
  switch (ch.toLowerCase()) {
    case "p":
      return "pawn";
    case "n":
      return "knight";
    case "b":
      return "bishop";
    case "r":
      return "rook";
    case "q":
      return "queen";
    case "k":
      return "king";
    default:
      return;
  }
}
function parseSquare(str) {
  if (str.length !== 2)
    return;
  return squareFromCoords(str.charCodeAt(0) - "a".charCodeAt(0), str.charCodeAt(1) - "1".charCodeAt(0));
}
var makeSquare = (square2) => FILE_NAMES[squareFile(square2)] + RANK_NAMES[squareRank(square2)];
var parseUci = (str) => {
  if (str[1] === "@" && str.length === 4) {
    const role = charToRole(str[0]);
    const to = parseSquare(str.slice(2));
    if (role && defined(to))
      return { role, to };
  } else if (str.length === 4 || str.length === 5) {
    const from = parseSquare(str.slice(0, 2));
    const to = parseSquare(str.slice(2, 4));
    let promotion;
    if (str.length === 5) {
      promotion = charToRole(str[4]);
      if (!promotion)
        return;
    }
    if (defined(from) && defined(to))
      return { from, to, promotion };
  }
  return;
};
var makeUci = (move) => isDrop(move) ? `${roleToChar(move.role).toUpperCase()}@${makeSquare(move.to)}` : makeSquare(move.from) + makeSquare(move.to) + (move.promotion ? roleToChar(move.promotion) : "");
var kingCastlesTo = (color, side) => color === "white" ? side === "a" ? 2 : 6 : side === "a" ? 58 : 62;
var rookCastlesTo = (color, side) => color === "white" ? side === "a" ? 3 : 5 : side === "a" ? 59 : 61;

// node_modules/chessops/dist/esm/squareSet.js
var popcnt32 = (n) => {
  n = n - (n >>> 1 & 1431655765);
  n = (n & 858993459) + (n >>> 2 & 858993459);
  return Math.imul(n + (n >>> 4) & 252645135, 16843009) >> 24;
};
var bswap32 = (n) => {
  n = n >>> 8 & 16711935 | (n & 16711935) << 8;
  return n >>> 16 & 65535 | (n & 65535) << 16;
};
var rbit32 = (n) => {
  n = n >>> 1 & 1431655765 | (n & 1431655765) << 1;
  n = n >>> 2 & 858993459 | (n & 858993459) << 2;
  n = n >>> 4 & 252645135 | (n & 252645135) << 4;
  return bswap32(n);
};
var SquareSet = class _SquareSet {
  constructor(lo, hi) {
    this.lo = lo | 0;
    this.hi = hi | 0;
  }
  static fromSquare(square2) {
    return square2 >= 32 ? new _SquareSet(0, 1 << square2 - 32) : new _SquareSet(1 << square2, 0);
  }
  static fromRank(rank) {
    return new _SquareSet(255, 0).shl64(8 * rank);
  }
  static fromFile(file) {
    return new _SquareSet(16843009 << file, 16843009 << file);
  }
  static empty() {
    return new _SquareSet(0, 0);
  }
  static full() {
    return new _SquareSet(4294967295, 4294967295);
  }
  static corners() {
    return new _SquareSet(129, 2164260864);
  }
  static center() {
    return new _SquareSet(402653184, 24);
  }
  static backranks() {
    return new _SquareSet(255, 4278190080);
  }
  static backrank(color) {
    return color === "white" ? new _SquareSet(255, 0) : new _SquareSet(0, 4278190080);
  }
  static lightSquares() {
    return new _SquareSet(1437226410, 1437226410);
  }
  static darkSquares() {
    return new _SquareSet(2857740885, 2857740885);
  }
  complement() {
    return new _SquareSet(~this.lo, ~this.hi);
  }
  xor(other) {
    return new _SquareSet(this.lo ^ other.lo, this.hi ^ other.hi);
  }
  union(other) {
    return new _SquareSet(this.lo | other.lo, this.hi | other.hi);
  }
  intersect(other) {
    return new _SquareSet(this.lo & other.lo, this.hi & other.hi);
  }
  diff(other) {
    return new _SquareSet(this.lo & ~other.lo, this.hi & ~other.hi);
  }
  intersects(other) {
    return this.intersect(other).nonEmpty();
  }
  isDisjoint(other) {
    return this.intersect(other).isEmpty();
  }
  supersetOf(other) {
    return other.diff(this).isEmpty();
  }
  subsetOf(other) {
    return this.diff(other).isEmpty();
  }
  shr64(shift) {
    if (shift >= 64)
      return _SquareSet.empty();
    if (shift >= 32)
      return new _SquareSet(this.hi >>> shift - 32, 0);
    if (shift > 0)
      return new _SquareSet(this.lo >>> shift ^ this.hi << 32 - shift, this.hi >>> shift);
    return this;
  }
  shl64(shift) {
    if (shift >= 64)
      return _SquareSet.empty();
    if (shift >= 32)
      return new _SquareSet(0, this.lo << shift - 32);
    if (shift > 0)
      return new _SquareSet(this.lo << shift, this.hi << shift ^ this.lo >>> 32 - shift);
    return this;
  }
  bswap64() {
    return new _SquareSet(bswap32(this.hi), bswap32(this.lo));
  }
  rbit64() {
    return new _SquareSet(rbit32(this.hi), rbit32(this.lo));
  }
  minus64(other) {
    const lo = this.lo - other.lo;
    const c = (lo & other.lo & 1) + (other.lo >>> 1) + (lo >>> 1) >>> 31;
    return new _SquareSet(lo, this.hi - (other.hi + c));
  }
  equals(other) {
    return this.lo === other.lo && this.hi === other.hi;
  }
  size() {
    return popcnt32(this.lo) + popcnt32(this.hi);
  }
  isEmpty() {
    return this.lo === 0 && this.hi === 0;
  }
  nonEmpty() {
    return this.lo !== 0 || this.hi !== 0;
  }
  has(square2) {
    return (square2 >= 32 ? this.hi & 1 << square2 - 32 : this.lo & 1 << square2) !== 0;
  }
  set(square2, on) {
    return on ? this.with(square2) : this.without(square2);
  }
  with(square2) {
    return square2 >= 32 ? new _SquareSet(this.lo, this.hi | 1 << square2 - 32) : new _SquareSet(this.lo | 1 << square2, this.hi);
  }
  without(square2) {
    return square2 >= 32 ? new _SquareSet(this.lo, this.hi & ~(1 << square2 - 32)) : new _SquareSet(this.lo & ~(1 << square2), this.hi);
  }
  toggle(square2) {
    return square2 >= 32 ? new _SquareSet(this.lo, this.hi ^ 1 << square2 - 32) : new _SquareSet(this.lo ^ 1 << square2, this.hi);
  }
  last() {
    if (this.hi !== 0)
      return 63 - Math.clz32(this.hi);
    if (this.lo !== 0)
      return 31 - Math.clz32(this.lo);
    return;
  }
  first() {
    if (this.lo !== 0)
      return 31 - Math.clz32(this.lo & -this.lo);
    if (this.hi !== 0)
      return 63 - Math.clz32(this.hi & -this.hi);
    return;
  }
  withoutFirst() {
    if (this.lo !== 0)
      return new _SquareSet(this.lo & this.lo - 1, this.hi);
    return new _SquareSet(0, this.hi & this.hi - 1);
  }
  moreThanOne() {
    return this.hi !== 0 && this.lo !== 0 || (this.lo & this.lo - 1) !== 0 || (this.hi & this.hi - 1) !== 0;
  }
  singleSquare() {
    return this.moreThanOne() ? void 0 : this.last();
  }
  *[Symbol.iterator]() {
    let lo = this.lo;
    let hi = this.hi;
    while (lo !== 0) {
      const idx = 31 - Math.clz32(lo & -lo);
      lo ^= 1 << idx;
      yield idx;
    }
    while (hi !== 0) {
      const idx = 31 - Math.clz32(hi & -hi);
      hi ^= 1 << idx;
      yield 32 + idx;
    }
  }
  *reversed() {
    let lo = this.lo;
    let hi = this.hi;
    while (hi !== 0) {
      const idx = 31 - Math.clz32(hi);
      hi ^= 1 << idx;
      yield 32 + idx;
    }
    while (lo !== 0) {
      const idx = 31 - Math.clz32(lo);
      lo ^= 1 << idx;
      yield idx;
    }
  }
};

// node_modules/chessops/dist/esm/attacks.js
var computeRange = (square2, deltas) => {
  let range = SquareSet.empty();
  for (const delta of deltas) {
    const sq = square2 + delta;
    if (0 <= sq && sq < 64 && Math.abs(squareFile(square2) - squareFile(sq)) <= 2) {
      range = range.with(sq);
    }
  }
  return range;
};
var tabulate = (f) => {
  const table = [];
  for (let square2 = 0; square2 < 64; square2++)
    table[square2] = f(square2);
  return table;
};
var KING_ATTACKS = tabulate((sq) => computeRange(sq, [-9, -8, -7, -1, 1, 7, 8, 9]));
var KNIGHT_ATTACKS = tabulate((sq) => computeRange(sq, [-17, -15, -10, -6, 6, 10, 15, 17]));
var PAWN_ATTACKS = {
  white: tabulate((sq) => computeRange(sq, [7, 9])),
  black: tabulate((sq) => computeRange(sq, [-7, -9]))
};
var kingAttacks = (square2) => KING_ATTACKS[square2];
var knightAttacks = (square2) => KNIGHT_ATTACKS[square2];
var pawnAttacks = (color, square2) => PAWN_ATTACKS[color][square2];
var FILE_RANGE = tabulate((sq) => SquareSet.fromFile(squareFile(sq)).without(sq));
var RANK_RANGE = tabulate((sq) => SquareSet.fromRank(squareRank(sq)).without(sq));
var DIAG_RANGE = tabulate((sq) => {
  const diag = new SquareSet(134480385, 2151686160);
  const shift = 8 * (squareRank(sq) - squareFile(sq));
  return (shift >= 0 ? diag.shl64(shift) : diag.shr64(-shift)).without(sq);
});
var ANTI_DIAG_RANGE = tabulate((sq) => {
  const diag = new SquareSet(270549120, 16909320);
  const shift = 8 * (squareRank(sq) + squareFile(sq) - 7);
  return (shift >= 0 ? diag.shl64(shift) : diag.shr64(-shift)).without(sq);
});
var hyperbola = (sq, range, occupied) => {
  const o = range.intersect(occupied);
  const fwd = o.minus64(SquareSet.fromSquare(sq));
  const rev = o.bswap64().minus64(SquareSet.fromSquare(56 ^ sq));
  return fwd.xor(rev.bswap64()).intersect(range);
};
var rankAttacks = (sq, occupied) => {
  const range = RANK_RANGE[sq];
  const o = range.intersect(occupied);
  const fwd = o.minus64(SquareSet.fromSquare(sq));
  const rev = o.rbit64().minus64(SquareSet.fromSquare(63 - sq));
  return fwd.xor(rev.rbit64()).intersect(range);
};
var bishopAttacks = (square2, occupied) => {
  return hyperbola(square2, DIAG_RANGE[square2], occupied).xor(hyperbola(square2, ANTI_DIAG_RANGE[square2], occupied));
};
var rookAttacks = (square2, occupied) => hyperbola(square2, FILE_RANGE[square2], occupied).xor(rankAttacks(square2, occupied));
var queenAttacks = (square2, occupied) => bishopAttacks(square2, occupied).xor(rookAttacks(square2, occupied));
var attacks = (piece2, square2, occupied) => {
  switch (piece2.role) {
    case "pawn":
      return pawnAttacks(piece2.color, square2);
    case "knight":
      return knightAttacks(square2);
    case "bishop":
      return bishopAttacks(square2, occupied);
    case "rook":
      return rookAttacks(square2, occupied);
    case "queen":
      return queenAttacks(square2, occupied);
    case "king":
      return kingAttacks(square2);
  }
};
var ray = (a, b) => {
  const other = SquareSet.fromSquare(b);
  if (RANK_RANGE[a].intersects(other))
    return RANK_RANGE[a].with(a);
  if (ANTI_DIAG_RANGE[a].intersects(other))
    return ANTI_DIAG_RANGE[a].with(a);
  if (DIAG_RANGE[a].intersects(other))
    return DIAG_RANGE[a].with(a);
  if (FILE_RANGE[a].intersects(other))
    return FILE_RANGE[a].with(a);
  return SquareSet.empty();
};
var between = (a, b) => ray(a, b).intersect(SquareSet.full().shl64(a).xor(SquareSet.full().shl64(b))).withoutFirst();

// node_modules/chessops/dist/esm/board.js
var Board = class _Board {
  constructor() {
  }
  static default() {
    const board2 = new _Board();
    board2.reset();
    return board2;
  }
  /**
   * Resets all pieces to the default starting position for standard chess.
   */
  reset() {
    this.occupied = new SquareSet(65535, 4294901760);
    this.promoted = SquareSet.empty();
    this.white = new SquareSet(65535, 0);
    this.black = new SquareSet(0, 4294901760);
    this.pawn = new SquareSet(65280, 16711680);
    this.knight = new SquareSet(66, 1107296256);
    this.bishop = new SquareSet(36, 603979776);
    this.rook = new SquareSet(129, 2164260864);
    this.queen = new SquareSet(8, 134217728);
    this.king = new SquareSet(16, 268435456);
  }
  static empty() {
    const board2 = new _Board();
    board2.clear();
    return board2;
  }
  clear() {
    this.occupied = SquareSet.empty();
    this.promoted = SquareSet.empty();
    for (const color of COLORS)
      this[color] = SquareSet.empty();
    for (const role of ROLES)
      this[role] = SquareSet.empty();
  }
  clone() {
    const board2 = new _Board();
    board2.occupied = this.occupied;
    board2.promoted = this.promoted;
    for (const color of COLORS)
      board2[color] = this[color];
    for (const role of ROLES)
      board2[role] = this[role];
    return board2;
  }
  getColor(square2) {
    if (this.white.has(square2))
      return "white";
    if (this.black.has(square2))
      return "black";
    return;
  }
  getRole(square2) {
    for (const role of ROLES) {
      if (this[role].has(square2))
        return role;
    }
    return;
  }
  get(square2) {
    const color = this.getColor(square2);
    if (!color)
      return;
    const role = this.getRole(square2);
    const promoted = this.promoted.has(square2);
    return { color, role, promoted };
  }
  /**
   * Removes and returns the piece from the given `square`, if any.
   */
  take(square2) {
    const piece2 = this.get(square2);
    if (piece2) {
      this.occupied = this.occupied.without(square2);
      this[piece2.color] = this[piece2.color].without(square2);
      this[piece2.role] = this[piece2.role].without(square2);
      if (piece2.promoted)
        this.promoted = this.promoted.without(square2);
    }
    return piece2;
  }
  /**
   * Put `piece` onto `square`, potentially replacing an existing piece.
   * Returns the existing piece, if any.
   */
  set(square2, piece2) {
    const old = this.take(square2);
    this.occupied = this.occupied.with(square2);
    this[piece2.color] = this[piece2.color].with(square2);
    this[piece2.role] = this[piece2.role].with(square2);
    if (piece2.promoted)
      this.promoted = this.promoted.with(square2);
    return old;
  }
  has(square2) {
    return this.occupied.has(square2);
  }
  *[Symbol.iterator]() {
    for (const square2 of this.occupied) {
      yield [square2, this.get(square2)];
    }
  }
  pieces(color, role) {
    return this[color].intersect(this[role]);
  }
  rooksAndQueens() {
    return this.rook.union(this.queen);
  }
  bishopsAndQueens() {
    return this.bishop.union(this.queen);
  }
  steppers() {
    return this.knight.union(this.pawn).union(this.king);
  }
  sliders() {
    return this.bishop.union(this.rook).union(this.queen);
  }
  /**
   * Finds the unique king of the given `color`, if any.
   */
  kingOf(color) {
    return this.pieces(color, "king").singleSquare();
  }
};
var boardEquals = (left, right) => left.white.equals(right.white) && left.promoted.equals(right.promoted) && ROLES.every((role) => left[role].equals(right[role]));

// node_modules/chessops/dist/esm/setup.js
var MaterialSide = class _MaterialSide {
  constructor() {
  }
  static empty() {
    const m = new _MaterialSide();
    for (const role of ROLES)
      m[role] = 0;
    return m;
  }
  static fromBoard(board2, color) {
    const m = new _MaterialSide();
    for (const role of ROLES)
      m[role] = board2.pieces(color, role).size();
    return m;
  }
  clone() {
    const m = new _MaterialSide();
    for (const role of ROLES)
      m[role] = this[role];
    return m;
  }
  equals(other) {
    return ROLES.every((role) => this[role] === other[role]);
  }
  add(other) {
    const m = new _MaterialSide();
    for (const role of ROLES)
      m[role] = this[role] + other[role];
    return m;
  }
  subtract(other) {
    const m = new _MaterialSide();
    for (const role of ROLES)
      m[role] = this[role] - other[role];
    return m;
  }
  nonEmpty() {
    return ROLES.some((role) => this[role] > 0);
  }
  isEmpty() {
    return !this.nonEmpty();
  }
  hasPawns() {
    return this.pawn > 0;
  }
  hasNonPawns() {
    return this.knight > 0 || this.bishop > 0 || this.rook > 0 || this.queen > 0 || this.king > 0;
  }
  size() {
    return this.pawn + this.knight + this.bishop + this.rook + this.queen + this.king;
  }
};
var Material = class _Material {
  constructor(white, black) {
    this.white = white;
    this.black = black;
  }
  static empty() {
    return new _Material(MaterialSide.empty(), MaterialSide.empty());
  }
  static fromBoard(board2) {
    return new _Material(MaterialSide.fromBoard(board2, "white"), MaterialSide.fromBoard(board2, "black"));
  }
  clone() {
    return new _Material(this.white.clone(), this.black.clone());
  }
  equals(other) {
    return this.white.equals(other.white) && this.black.equals(other.black);
  }
  add(other) {
    return new _Material(this.white.add(other.white), this.black.add(other.black));
  }
  subtract(other) {
    return new _Material(this.white.subtract(other.white), this.black.subtract(other.black));
  }
  count(role) {
    return this.white[role] + this.black[role];
  }
  size() {
    return this.white.size() + this.black.size();
  }
  isEmpty() {
    return this.white.isEmpty() && this.black.isEmpty();
  }
  nonEmpty() {
    return !this.isEmpty();
  }
  hasPawns() {
    return this.white.hasPawns() || this.black.hasPawns();
  }
  hasNonPawns() {
    return this.white.hasNonPawns() || this.black.hasNonPawns();
  }
};
var RemainingChecks = class _RemainingChecks {
  constructor(white, black) {
    this.white = white;
    this.black = black;
  }
  static default() {
    return new _RemainingChecks(3, 3);
  }
  clone() {
    return new _RemainingChecks(this.white, this.black);
  }
  equals(other) {
    return this.white === other.white && this.black === other.black;
  }
};
var defaultSetup = () => ({
  board: Board.default(),
  pockets: void 0,
  turn: "white",
  castlingRights: SquareSet.corners(),
  epSquare: void 0,
  remainingChecks: void 0,
  halfmoves: 0,
  fullmoves: 1
});
var emptySetup = () => ({
  board: Board.empty(),
  pockets: void 0,
  turn: "white",
  castlingRights: SquareSet.empty(),
  epSquare: void 0,
  remainingChecks: void 0,
  halfmoves: 0,
  fullmoves: 1
});
var setupClone = (setup) => {
  var _a, _b;
  return {
    board: setup.board.clone(),
    pockets: (_a = setup.pockets) === null || _a === void 0 ? void 0 : _a.clone(),
    turn: setup.turn,
    castlingRights: setup.castlingRights,
    epSquare: setup.epSquare,
    remainingChecks: (_b = setup.remainingChecks) === null || _b === void 0 ? void 0 : _b.clone(),
    halfmoves: setup.halfmoves,
    fullmoves: setup.fullmoves
  };
};
var setupEquals = (left, right) => {
  var _a, _b;
  return boardEquals(left.board, right.board) && (right.pockets && ((_a = left.pockets) === null || _a === void 0 ? void 0 : _a.equals(right.pockets)) || !left.pockets && !right.pockets) && left.turn === right.turn && left.castlingRights.equals(right.castlingRights) && left.epSquare === right.epSquare && (right.remainingChecks && ((_b = left.remainingChecks) === null || _b === void 0 ? void 0 : _b.equals(right.remainingChecks)) || !left.remainingChecks && !right.remainingChecks) && left.halfmoves === right.halfmoves && left.fullmoves === right.fullmoves;
};

// node_modules/@badrap/result/dist/mjs/index.mjs
var _Result = class {
  unwrap(ok, err) {
    const r = this._chain((value) => Result.ok(ok ? ok(value) : value), (error) => err ? Result.ok(err(error)) : Result.err(error));
    if (r.isErr) {
      throw r.error;
    }
    return r.value;
  }
  map(ok, err) {
    return this._chain((value) => Result.ok(ok(value)), (error) => Result.err(err ? err(error) : error));
  }
  chain(ok, err) {
    return this._chain(ok, err !== null && err !== void 0 ? err : ((error) => Result.err(error)));
  }
};
var _Ok = class extends _Result {
  constructor(value) {
    super();
    this.value = value;
    this.isOk = true;
    this.isErr = false;
  }
  _chain(ok, _err) {
    return ok(this.value);
  }
};
var _Err = class extends _Result {
  constructor(error) {
    super();
    this.error = error;
    this.isOk = false;
    this.isErr = true;
  }
  _chain(_ok, err) {
    return err(this.error);
  }
};
var Result;
(function(Result2) {
  function ok(value) {
    return new _Ok(value);
  }
  Result2.ok = ok;
  function err(error) {
    return new _Err(error || new Error());
  }
  Result2.err = err;
  function all(obj) {
    if (Array.isArray(obj)) {
      const res2 = [];
      for (let i = 0; i < obj.length; i++) {
        const item = obj[i];
        if (item.isErr) {
          return item;
        }
        res2.push(item.value);
      }
      return Result2.ok(res2);
    }
    const res = {};
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const item = obj[keys[i]];
      if (item.isErr) {
        return item;
      }
      res[keys[i]] = item.value;
    }
    return Result2.ok(res);
  }
  Result2.all = all;
})(Result || (Result = {}));

// node_modules/chessops/dist/esm/chess.js
var IllegalSetup;
(function(IllegalSetup2) {
  IllegalSetup2["Empty"] = "ERR_EMPTY";
  IllegalSetup2["OppositeCheck"] = "ERR_OPPOSITE_CHECK";
  IllegalSetup2["PawnsOnBackrank"] = "ERR_PAWNS_ON_BACKRANK";
  IllegalSetup2["Kings"] = "ERR_KINGS";
  IllegalSetup2["Variant"] = "ERR_VARIANT";
})(IllegalSetup || (IllegalSetup = {}));
var PositionError = class extends Error {
};
var attacksTo = (square2, attacker, board2, occupied) => board2[attacker].intersect(rookAttacks(square2, occupied).intersect(board2.rooksAndQueens()).union(bishopAttacks(square2, occupied).intersect(board2.bishopsAndQueens())).union(knightAttacks(square2).intersect(board2.knight)).union(kingAttacks(square2).intersect(board2.king)).union(pawnAttacks(opposite(attacker), square2).intersect(board2.pawn)));
var Castles = class _Castles {
  constructor() {
  }
  static default() {
    const castles = new _Castles();
    castles.castlingRights = SquareSet.corners();
    castles.rook = {
      white: { a: 0, h: 7 },
      black: { a: 56, h: 63 }
    };
    castles.path = {
      white: { a: new SquareSet(14, 0), h: new SquareSet(96, 0) },
      black: { a: new SquareSet(0, 234881024), h: new SquareSet(0, 1610612736) }
    };
    return castles;
  }
  static empty() {
    const castles = new _Castles();
    castles.castlingRights = SquareSet.empty();
    castles.rook = {
      white: { a: void 0, h: void 0 },
      black: { a: void 0, h: void 0 }
    };
    castles.path = {
      white: { a: SquareSet.empty(), h: SquareSet.empty() },
      black: { a: SquareSet.empty(), h: SquareSet.empty() }
    };
    return castles;
  }
  clone() {
    const castles = new _Castles();
    castles.castlingRights = this.castlingRights;
    castles.rook = {
      white: { a: this.rook.white.a, h: this.rook.white.h },
      black: { a: this.rook.black.a, h: this.rook.black.h }
    };
    castles.path = {
      white: { a: this.path.white.a, h: this.path.white.h },
      black: { a: this.path.black.a, h: this.path.black.h }
    };
    return castles;
  }
  add(color, side, king, rook) {
    const kingTo = kingCastlesTo(color, side);
    const rookTo = rookCastlesTo(color, side);
    this.castlingRights = this.castlingRights.with(rook);
    this.rook[color][side] = rook;
    this.path[color][side] = between(rook, rookTo).with(rookTo).union(between(king, kingTo).with(kingTo)).without(king).without(rook);
  }
  static fromSetup(setup) {
    const castles = _Castles.empty();
    const rooks = setup.castlingRights.intersect(setup.board.rook);
    for (const color of COLORS) {
      const backrank = SquareSet.backrank(color);
      const king = setup.board.kingOf(color);
      if (!defined(king) || !backrank.has(king))
        continue;
      const side = rooks.intersect(setup.board[color]).intersect(backrank);
      const aSide = side.first();
      if (defined(aSide) && aSide < king)
        castles.add(color, "a", king, aSide);
      const hSide = side.last();
      if (defined(hSide) && king < hSide)
        castles.add(color, "h", king, hSide);
    }
    return castles;
  }
  discardRook(square2) {
    if (this.castlingRights.has(square2)) {
      this.castlingRights = this.castlingRights.without(square2);
      for (const color of COLORS) {
        for (const side of CASTLING_SIDES) {
          if (this.rook[color][side] === square2)
            this.rook[color][side] = void 0;
        }
      }
    }
  }
  discardColor(color) {
    this.castlingRights = this.castlingRights.diff(SquareSet.backrank(color));
    this.rook[color].a = void 0;
    this.rook[color].h = void 0;
  }
};
var Position = class {
  constructor(rules) {
    this.rules = rules;
  }
  reset() {
    this.board = Board.default();
    this.pockets = void 0;
    this.turn = "white";
    this.castles = Castles.default();
    this.epSquare = void 0;
    this.remainingChecks = void 0;
    this.halfmoves = 0;
    this.fullmoves = 1;
  }
  setupUnchecked(setup) {
    this.board = setup.board.clone();
    this.board.promoted = SquareSet.empty();
    this.pockets = void 0;
    this.turn = setup.turn;
    this.castles = Castles.fromSetup(setup);
    this.epSquare = validEpSquare(this, setup.epSquare);
    this.remainingChecks = void 0;
    this.halfmoves = setup.halfmoves;
    this.fullmoves = setup.fullmoves;
  }
  // When subclassing overwrite at least:
  //
  // - static default()
  // - static fromSetup()
  // - static clone()
  //
  // - dests()
  // - isVariantEnd()
  // - variantOutcome()
  // - hasInsufficientMaterial()
  // - isStandardMaterial()
  kingAttackers(square2, attacker, occupied) {
    return attacksTo(square2, attacker, this.board, occupied);
  }
  playCaptureAt(square2, captured) {
    this.halfmoves = 0;
    if (captured.role === "rook")
      this.castles.discardRook(square2);
    if (this.pockets)
      this.pockets[opposite(captured.color)][captured.promoted ? "pawn" : captured.role]++;
  }
  ctx() {
    const variantEnd = this.isVariantEnd();
    const king = this.board.kingOf(this.turn);
    if (!defined(king)) {
      return { king, blockers: SquareSet.empty(), checkers: SquareSet.empty(), variantEnd, mustCapture: false };
    }
    const snipers = rookAttacks(king, SquareSet.empty()).intersect(this.board.rooksAndQueens()).union(bishopAttacks(king, SquareSet.empty()).intersect(this.board.bishopsAndQueens())).intersect(this.board[opposite(this.turn)]);
    let blockers = SquareSet.empty();
    for (const sniper of snipers) {
      const b = between(king, sniper).intersect(this.board.occupied);
      if (!b.moreThanOne())
        blockers = blockers.union(b);
    }
    const checkers = this.kingAttackers(king, opposite(this.turn), this.board.occupied);
    return {
      king,
      blockers,
      checkers,
      variantEnd,
      mustCapture: false
    };
  }
  clone() {
    var _a, _b;
    const pos = new this.constructor();
    pos.board = this.board.clone();
    pos.pockets = (_a = this.pockets) === null || _a === void 0 ? void 0 : _a.clone();
    pos.turn = this.turn;
    pos.castles = this.castles.clone();
    pos.epSquare = this.epSquare;
    pos.remainingChecks = (_b = this.remainingChecks) === null || _b === void 0 ? void 0 : _b.clone();
    pos.halfmoves = this.halfmoves;
    pos.fullmoves = this.fullmoves;
    return pos;
  }
  validate() {
    if (this.board.occupied.isEmpty())
      return Result.err(new PositionError(IllegalSetup.Empty));
    if (this.board.king.size() !== 2)
      return Result.err(new PositionError(IllegalSetup.Kings));
    if (!defined(this.board.kingOf(this.turn)))
      return Result.err(new PositionError(IllegalSetup.Kings));
    const otherKing = this.board.kingOf(opposite(this.turn));
    if (!defined(otherKing))
      return Result.err(new PositionError(IllegalSetup.Kings));
    if (this.kingAttackers(otherKing, this.turn, this.board.occupied).nonEmpty()) {
      return Result.err(new PositionError(IllegalSetup.OppositeCheck));
    }
    if (SquareSet.backranks().intersects(this.board.pawn)) {
      return Result.err(new PositionError(IllegalSetup.PawnsOnBackrank));
    }
    return Result.ok(void 0);
  }
  dropDests(_ctx) {
    return SquareSet.empty();
  }
  dests(square2, ctx) {
    ctx = ctx || this.ctx();
    if (ctx.variantEnd)
      return SquareSet.empty();
    const piece2 = this.board.get(square2);
    if (!piece2 || piece2.color !== this.turn)
      return SquareSet.empty();
    let pseudo, legal;
    if (piece2.role === "pawn") {
      pseudo = pawnAttacks(this.turn, square2).intersect(this.board[opposite(this.turn)]);
      const delta = this.turn === "white" ? 8 : -8;
      const step = square2 + delta;
      if (0 <= step && step < 64 && !this.board.occupied.has(step)) {
        pseudo = pseudo.with(step);
        const canDoubleStep = this.turn === "white" ? square2 < 16 : square2 >= 64 - 16;
        const doubleStep = step + delta;
        if (canDoubleStep && !this.board.occupied.has(doubleStep)) {
          pseudo = pseudo.with(doubleStep);
        }
      }
      if (defined(this.epSquare) && canCaptureEp(this, square2, ctx)) {
        legal = SquareSet.fromSquare(this.epSquare);
      }
    } else if (piece2.role === "bishop")
      pseudo = bishopAttacks(square2, this.board.occupied);
    else if (piece2.role === "knight")
      pseudo = knightAttacks(square2);
    else if (piece2.role === "rook")
      pseudo = rookAttacks(square2, this.board.occupied);
    else if (piece2.role === "queen")
      pseudo = queenAttacks(square2, this.board.occupied);
    else
      pseudo = kingAttacks(square2);
    pseudo = pseudo.diff(this.board[this.turn]);
    if (defined(ctx.king)) {
      if (piece2.role === "king") {
        const occ = this.board.occupied.without(square2);
        for (const to of pseudo) {
          if (this.kingAttackers(to, opposite(this.turn), occ).nonEmpty())
            pseudo = pseudo.without(to);
        }
        return pseudo.union(castlingDest(this, "a", ctx)).union(castlingDest(this, "h", ctx));
      }
      if (ctx.checkers.nonEmpty()) {
        const checker = ctx.checkers.singleSquare();
        if (!defined(checker))
          return SquareSet.empty();
        pseudo = pseudo.intersect(between(checker, ctx.king).with(checker));
      }
      if (ctx.blockers.has(square2))
        pseudo = pseudo.intersect(ray(square2, ctx.king));
    }
    if (legal)
      pseudo = pseudo.union(legal);
    return pseudo;
  }
  isVariantEnd() {
    return false;
  }
  variantOutcome(_ctx) {
    return;
  }
  hasInsufficientMaterial(color) {
    if (this.board[color].intersect(this.board.pawn.union(this.board.rooksAndQueens())).nonEmpty())
      return false;
    if (this.board[color].intersects(this.board.knight)) {
      return this.board[color].size() <= 2 && this.board[opposite(color)].diff(this.board.king).diff(this.board.queen).isEmpty();
    }
    if (this.board[color].intersects(this.board.bishop)) {
      const sameColor = !this.board.bishop.intersects(SquareSet.darkSquares()) || !this.board.bishop.intersects(SquareSet.lightSquares());
      return sameColor && this.board.pawn.isEmpty() && this.board.knight.isEmpty();
    }
    return true;
  }
  // The following should be identical in all subclasses
  toSetup() {
    var _a, _b;
    return {
      board: this.board.clone(),
      pockets: (_a = this.pockets) === null || _a === void 0 ? void 0 : _a.clone(),
      turn: this.turn,
      castlingRights: this.castles.castlingRights,
      epSquare: legalEpSquare(this),
      remainingChecks: (_b = this.remainingChecks) === null || _b === void 0 ? void 0 : _b.clone(),
      halfmoves: Math.min(this.halfmoves, 150),
      fullmoves: Math.min(Math.max(this.fullmoves, 1), 9999)
    };
  }
  isInsufficientMaterial() {
    return COLORS.every((color) => this.hasInsufficientMaterial(color));
  }
  hasDests(ctx) {
    ctx = ctx || this.ctx();
    for (const square2 of this.board[this.turn]) {
      if (this.dests(square2, ctx).nonEmpty())
        return true;
    }
    return this.dropDests(ctx).nonEmpty();
  }
  isLegal(move, ctx) {
    if (isDrop(move)) {
      if (!this.pockets || this.pockets[this.turn][move.role] <= 0)
        return false;
      if (move.role === "pawn" && SquareSet.backranks().has(move.to))
        return false;
      return this.dropDests(ctx).has(move.to);
    } else {
      if (move.promotion === "pawn")
        return false;
      if (move.promotion === "king" && this.rules !== "antichess")
        return false;
      if (!!move.promotion !== (this.board.pawn.has(move.from) && SquareSet.backranks().has(move.to)))
        return false;
      const dests2 = this.dests(move.from, ctx);
      return dests2.has(move.to) || dests2.has(normalizeMove(this, move).to);
    }
  }
  isCheck() {
    const king = this.board.kingOf(this.turn);
    return defined(king) && this.kingAttackers(king, opposite(this.turn), this.board.occupied).nonEmpty();
  }
  isEnd(ctx) {
    if (ctx ? ctx.variantEnd : this.isVariantEnd())
      return true;
    return this.isInsufficientMaterial() || !this.hasDests(ctx);
  }
  isCheckmate(ctx) {
    ctx = ctx || this.ctx();
    return !ctx.variantEnd && ctx.checkers.nonEmpty() && !this.hasDests(ctx);
  }
  isStalemate(ctx) {
    ctx = ctx || this.ctx();
    return !ctx.variantEnd && ctx.checkers.isEmpty() && !this.hasDests(ctx);
  }
  outcome(ctx) {
    const variantOutcome = this.variantOutcome(ctx);
    if (variantOutcome)
      return variantOutcome;
    ctx = ctx || this.ctx();
    if (this.isCheckmate(ctx))
      return { winner: opposite(this.turn) };
    else if (this.isInsufficientMaterial() || this.isStalemate(ctx))
      return { winner: void 0 };
    else
      return;
  }
  allDests(ctx) {
    ctx = ctx || this.ctx();
    const d = /* @__PURE__ */ new Map();
    if (ctx.variantEnd)
      return d;
    for (const square2 of this.board[this.turn]) {
      d.set(square2, this.dests(square2, ctx));
    }
    return d;
  }
  play(move) {
    const turn = this.turn;
    const epSquare = this.epSquare;
    const castling = castlingSide(this, move);
    this.epSquare = void 0;
    this.halfmoves += 1;
    if (turn === "black")
      this.fullmoves += 1;
    this.turn = opposite(turn);
    if (isDrop(move)) {
      this.board.set(move.to, { role: move.role, color: turn });
      if (this.pockets)
        this.pockets[turn][move.role]--;
      if (move.role === "pawn")
        this.halfmoves = 0;
    } else {
      const piece2 = this.board.take(move.from);
      if (!piece2)
        return;
      let epCapture;
      if (piece2.role === "pawn") {
        this.halfmoves = 0;
        if (move.to === epSquare) {
          epCapture = this.board.take(move.to + (turn === "white" ? -8 : 8));
        }
        const delta = move.from - move.to;
        if (Math.abs(delta) === 16 && 8 <= move.from && move.from <= 55) {
          this.epSquare = move.from + move.to >> 1;
        }
        if (move.promotion) {
          piece2.role = move.promotion;
          piece2.promoted = !!this.pockets;
        }
      } else if (piece2.role === "rook") {
        this.castles.discardRook(move.from);
      } else if (piece2.role === "king") {
        if (castling) {
          const rookFrom = this.castles.rook[turn][castling];
          if (defined(rookFrom)) {
            const rook = this.board.take(rookFrom);
            this.board.set(kingCastlesTo(turn, castling), piece2);
            if (rook)
              this.board.set(rookCastlesTo(turn, castling), rook);
          }
        }
        this.castles.discardColor(turn);
      }
      if (!castling) {
        const capture = this.board.set(move.to, piece2) || epCapture;
        if (capture)
          this.playCaptureAt(move.to, capture);
      }
    }
    if (this.remainingChecks) {
      if (this.isCheck())
        this.remainingChecks[turn] = Math.max(this.remainingChecks[turn] - 1, 0);
    }
  }
};
var Chess = class extends Position {
  constructor() {
    super("chess");
  }
  static default() {
    const pos = new this();
    pos.reset();
    return pos;
  }
  static fromSetup(setup) {
    const pos = new this();
    pos.setupUnchecked(setup);
    return pos.validate().map((_) => pos);
  }
  clone() {
    return super.clone();
  }
};
var validEpSquare = (pos, square2) => {
  if (!defined(square2))
    return;
  const epRank = pos.turn === "white" ? 5 : 2;
  const forward = pos.turn === "white" ? 8 : -8;
  if (squareRank(square2) !== epRank)
    return;
  if (pos.board.occupied.has(square2 + forward))
    return;
  const pawn = square2 - forward;
  if (!pos.board.pawn.has(pawn) || !pos.board[opposite(pos.turn)].has(pawn))
    return;
  return square2;
};
var legalEpSquare = (pos) => {
  if (!defined(pos.epSquare))
    return;
  const ctx = pos.ctx();
  const ourPawns = pos.board.pieces(pos.turn, "pawn");
  const candidates = ourPawns.intersect(pawnAttacks(opposite(pos.turn), pos.epSquare));
  for (const candidate of candidates) {
    if (pos.dests(candidate, ctx).has(pos.epSquare))
      return pos.epSquare;
  }
  return;
};
var canCaptureEp = (pos, pawnFrom, ctx) => {
  if (!defined(pos.epSquare))
    return false;
  if (!pawnAttacks(pos.turn, pawnFrom).has(pos.epSquare))
    return false;
  if (!defined(ctx.king))
    return true;
  const delta = pos.turn === "white" ? 8 : -8;
  const captured = pos.epSquare - delta;
  return pos.kingAttackers(ctx.king, opposite(pos.turn), pos.board.occupied.toggle(pawnFrom).toggle(captured).with(pos.epSquare)).without(captured).isEmpty();
};
var castlingDest = (pos, side, ctx) => {
  if (!defined(ctx.king) || ctx.checkers.nonEmpty())
    return SquareSet.empty();
  const rook = pos.castles.rook[pos.turn][side];
  if (!defined(rook))
    return SquareSet.empty();
  if (pos.castles.path[pos.turn][side].intersects(pos.board.occupied))
    return SquareSet.empty();
  const kingTo = kingCastlesTo(pos.turn, side);
  const kingPath = between(ctx.king, kingTo);
  const occ = pos.board.occupied.without(ctx.king);
  for (const sq of kingPath) {
    if (pos.kingAttackers(sq, opposite(pos.turn), occ).nonEmpty())
      return SquareSet.empty();
  }
  const rookTo = rookCastlesTo(pos.turn, side);
  const after = pos.board.occupied.toggle(ctx.king).toggle(rook).toggle(rookTo);
  if (pos.kingAttackers(kingTo, opposite(pos.turn), after).nonEmpty())
    return SquareSet.empty();
  return SquareSet.fromSquare(rook);
};
var pseudoDests = (pos, square2, ctx) => {
  if (ctx.variantEnd)
    return SquareSet.empty();
  const piece2 = pos.board.get(square2);
  if (!piece2 || piece2.color !== pos.turn)
    return SquareSet.empty();
  let pseudo = attacks(piece2, square2, pos.board.occupied);
  if (piece2.role === "pawn") {
    let captureTargets = pos.board[opposite(pos.turn)];
    if (defined(pos.epSquare))
      captureTargets = captureTargets.with(pos.epSquare);
    pseudo = pseudo.intersect(captureTargets);
    const delta = pos.turn === "white" ? 8 : -8;
    const step = square2 + delta;
    if (0 <= step && step < 64 && !pos.board.occupied.has(step)) {
      pseudo = pseudo.with(step);
      const canDoubleStep = pos.turn === "white" ? square2 < 16 : square2 >= 64 - 16;
      const doubleStep = step + delta;
      if (canDoubleStep && !pos.board.occupied.has(doubleStep)) {
        pseudo = pseudo.with(doubleStep);
      }
    }
    return pseudo;
  } else {
    pseudo = pseudo.diff(pos.board[pos.turn]);
  }
  if (square2 === ctx.king)
    return pseudo.union(castlingDest(pos, "a", ctx)).union(castlingDest(pos, "h", ctx));
  else
    return pseudo;
};
var equalsIgnoreMoves = (left, right) => {
  var _a, _b;
  return left.rules === right.rules && boardEquals(left.board, right.board) && (right.pockets && ((_a = left.pockets) === null || _a === void 0 ? void 0 : _a.equals(right.pockets)) || !left.pockets && !right.pockets) && left.turn === right.turn && left.castles.castlingRights.equals(right.castles.castlingRights) && legalEpSquare(left) === legalEpSquare(right) && (right.remainingChecks && ((_b = left.remainingChecks) === null || _b === void 0 ? void 0 : _b.equals(right.remainingChecks)) || !left.remainingChecks && !right.remainingChecks);
};
var castlingSide = (pos, move) => {
  if (isDrop(move))
    return;
  const delta = move.to - move.from;
  if (Math.abs(delta) !== 2 && !pos.board[pos.turn].has(move.to))
    return;
  if (!pos.board.king.has(move.from))
    return;
  return delta > 0 ? "h" : "a";
};
var normalizeMove = (pos, move) => {
  const side = castlingSide(pos, move);
  if (!side)
    return move;
  const rookFrom = pos.castles.rook[pos.turn][side];
  return {
    from: move.from,
    to: defined(rookFrom) ? rookFrom : move.to
  };
};
var isStandardMaterialSide = (board2, color) => {
  const promoted = Math.max(board2.pieces(color, "queen").size() - 1, 0) + Math.max(board2.pieces(color, "rook").size() - 2, 0) + Math.max(board2.pieces(color, "knight").size() - 2, 0) + Math.max(board2.pieces(color, "bishop").intersect(SquareSet.lightSquares()).size() - 1, 0) + Math.max(board2.pieces(color, "bishop").intersect(SquareSet.darkSquares()).size() - 1, 0);
  return board2.pieces(color, "pawn").size() + promoted <= 8;
};
var isImpossibleCheck = (pos) => {
  const ourKing = pos.board.kingOf(pos.turn);
  if (!defined(ourKing))
    return false;
  const checkers = pos.kingAttackers(ourKing, opposite(pos.turn), pos.board.occupied);
  if (checkers.isEmpty())
    return false;
  if (defined(pos.epSquare)) {
    const pushedTo = pos.epSquare ^ 8;
    const pushedFrom = pos.epSquare ^ 24;
    return checkers.moreThanOne() || checkers.first() !== pushedTo && pos.kingAttackers(ourKing, opposite(pos.turn), pos.board.occupied.without(pushedTo).with(pushedFrom)).nonEmpty();
  } else if (pos.rules === "atomic") {
    return false;
  } else {
    return checkers.size() > 2 || checkers.size() === 2 && ray(checkers.first(), checkers.last()).has(ourKing) || checkers.intersect(pos.board.steppers()).moreThanOne();
  }
};

// node_modules/chessops/dist/esm/compat.js
var compat_exports = {};
__export(compat_exports, {
  chessgroundDests: () => chessgroundDests,
  chessgroundMove: () => chessgroundMove,
  lichessRules: () => lichessRules,
  lichessVariant: () => lichessVariant,
  scalachessCharPair: () => scalachessCharPair
});
var chessgroundDests = (pos, opts) => {
  const result = /* @__PURE__ */ new Map();
  const ctx = pos.ctx();
  for (const [from, squares] of pos.allDests(ctx)) {
    if (squares.nonEmpty()) {
      const d = Array.from(squares, makeSquare);
      if (!(opts === null || opts === void 0 ? void 0 : opts.chess960) && from === ctx.king && squareFile(from) === 4) {
        if (squares.has(0))
          d.push("c1");
        else if (squares.has(56))
          d.push("c8");
        if (squares.has(7))
          d.push("g1");
        else if (squares.has(63))
          d.push("g8");
      }
      result.set(makeSquare(from), d);
    }
  }
  return result;
};
var chessgroundMove = (move) => isDrop(move) ? [makeSquare(move.to)] : [makeSquare(move.from), makeSquare(move.to)];
var scalachessCharPair = (move) => isDrop(move) ? String.fromCharCode(35 + move.to, 35 + 64 + 8 * 5 + ["queen", "rook", "bishop", "knight", "pawn"].indexOf(move.role)) : String.fromCharCode(35 + move.from, move.promotion ? 35 + 64 + 8 * ["queen", "rook", "bishop", "knight", "king"].indexOf(move.promotion) + squareFile(move.to) : 35 + move.to);
var lichessRules = (variant) => {
  switch (variant) {
    case "standard":
    case "chess960":
    case "fromPosition":
      return "chess";
    case "threeCheck":
      return "3check";
    case "kingOfTheHill":
      return "kingofthehill";
    case "racingKings":
      return "racingkings";
    default:
      return variant;
  }
};
var lichessVariant = (rules) => {
  switch (rules) {
    case "chess":
      return "standard";
    case "3check":
      return "threeCheck";
    case "kingofthehill":
      return "kingOfTheHill";
    case "racingkings":
      return "racingKings";
    default:
      return rules;
  }
};

// node_modules/chessops/dist/esm/debug.js
var debug_exports = {};
__export(debug_exports, {
  board: () => board,
  dests: () => dests,
  perft: () => perft,
  piece: () => piece,
  square: () => square,
  squareSet: () => squareSet
});

// node_modules/chessops/dist/esm/fen.js
var fen_exports = {};
__export(fen_exports, {
  EMPTY_BOARD_FEN: () => EMPTY_BOARD_FEN,
  EMPTY_EPD: () => EMPTY_EPD,
  EMPTY_FEN: () => EMPTY_FEN,
  FenError: () => FenError,
  INITIAL_BOARD_FEN: () => INITIAL_BOARD_FEN,
  INITIAL_EPD: () => INITIAL_EPD,
  INITIAL_FEN: () => INITIAL_FEN,
  InvalidFen: () => InvalidFen,
  makeBoardFen: () => makeBoardFen,
  makeCastlingFen: () => makeCastlingFen,
  makeFen: () => makeFen,
  makePiece: () => makePiece,
  makePocket: () => makePocket,
  makePockets: () => makePockets,
  makeRemainingChecks: () => makeRemainingChecks,
  parseBoardFen: () => parseBoardFen,
  parseCastlingFen: () => parseCastlingFen,
  parseFen: () => parseFen,
  parsePiece: () => parsePiece,
  parsePockets: () => parsePockets,
  parseRemainingChecks: () => parseRemainingChecks
});
var INITIAL_BOARD_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
var INITIAL_EPD = INITIAL_BOARD_FEN + " w KQkq -";
var INITIAL_FEN = INITIAL_EPD + " 0 1";
var EMPTY_BOARD_FEN = "8/8/8/8/8/8/8/8";
var EMPTY_EPD = EMPTY_BOARD_FEN + " w - -";
var EMPTY_FEN = EMPTY_EPD + " 0 1";
var InvalidFen;
(function(InvalidFen2) {
  InvalidFen2["Fen"] = "ERR_FEN";
  InvalidFen2["Board"] = "ERR_BOARD";
  InvalidFen2["Pockets"] = "ERR_POCKETS";
  InvalidFen2["Turn"] = "ERR_TURN";
  InvalidFen2["Castling"] = "ERR_CASTLING";
  InvalidFen2["EpSquare"] = "ERR_EP_SQUARE";
  InvalidFen2["RemainingChecks"] = "ERR_REMAINING_CHECKS";
  InvalidFen2["Halfmoves"] = "ERR_HALFMOVES";
  InvalidFen2["Fullmoves"] = "ERR_FULLMOVES";
})(InvalidFen || (InvalidFen = {}));
var FenError = class extends Error {
};
var nthIndexOf = (haystack, needle, n) => {
  let index = haystack.indexOf(needle);
  while (n-- > 0) {
    if (index === -1)
      break;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return index;
};
var parseSmallUint = (str) => /^\d{1,4}$/.test(str) ? parseInt(str, 10) : void 0;
var charToPiece = (ch) => {
  const role = charToRole(ch);
  return role && { role, color: ch.toLowerCase() === ch ? "black" : "white" };
};
var parseBoardFen = (boardPart) => {
  const board2 = Board.empty();
  let rank = 7;
  let file = 0;
  for (let i = 0; i < boardPart.length; i++) {
    const c = boardPart[i];
    if (c === "/" && file === 8) {
      file = 0;
      rank--;
    } else {
      const step = parseInt(c, 10);
      if (step > 0)
        file += step;
      else {
        if (file >= 8 || rank < 0)
          return Result.err(new FenError(InvalidFen.Board));
        const square2 = file + rank * 8;
        const piece2 = charToPiece(c);
        if (!piece2)
          return Result.err(new FenError(InvalidFen.Board));
        if (boardPart[i + 1] === "~") {
          piece2.promoted = true;
          i++;
        }
        board2.set(square2, piece2);
        file++;
      }
    }
  }
  if (rank !== 0 || file !== 8)
    return Result.err(new FenError(InvalidFen.Board));
  return Result.ok(board2);
};
var parsePockets = (pocketPart) => {
  if (pocketPart.length > 64)
    return Result.err(new FenError(InvalidFen.Pockets));
  const pockets = Material.empty();
  for (const c of pocketPart) {
    const piece2 = charToPiece(c);
    if (!piece2)
      return Result.err(new FenError(InvalidFen.Pockets));
    pockets[piece2.color][piece2.role]++;
  }
  return Result.ok(pockets);
};
var parseCastlingFen = (board2, castlingPart) => {
  let castlingRights = SquareSet.empty();
  if (castlingPart === "-")
    return Result.ok(castlingRights);
  for (const c of castlingPart) {
    const lower = c.toLowerCase();
    const color = c === lower ? "black" : "white";
    const rank = color === "white" ? 0 : 7;
    if ("a" <= lower && lower <= "h") {
      castlingRights = castlingRights.with(squareFromCoords(lower.charCodeAt(0) - "a".charCodeAt(0), rank));
    } else if (lower === "k" || lower === "q") {
      const rooksAndKings = board2[color].intersect(SquareSet.backrank(color)).intersect(board2.rook.union(board2.king));
      const candidate = lower === "k" ? rooksAndKings.last() : rooksAndKings.first();
      castlingRights = castlingRights.with(defined(candidate) && board2.rook.has(candidate) ? candidate : squareFromCoords(lower === "k" ? 7 : 0, rank));
    } else
      return Result.err(new FenError(InvalidFen.Castling));
  }
  if (COLORS.some((color) => SquareSet.backrank(color).intersect(castlingRights).size() > 2)) {
    return Result.err(new FenError(InvalidFen.Castling));
  }
  return Result.ok(castlingRights);
};
var parseRemainingChecks = (part) => {
  const parts = part.split("+");
  if (parts.length === 3 && parts[0] === "") {
    const white = parseSmallUint(parts[1]);
    const black = parseSmallUint(parts[2]);
    if (!defined(white) || white > 3 || !defined(black) || black > 3) {
      return Result.err(new FenError(InvalidFen.RemainingChecks));
    }
    return Result.ok(new RemainingChecks(3 - white, 3 - black));
  } else if (parts.length === 2) {
    const white = parseSmallUint(parts[0]);
    const black = parseSmallUint(parts[1]);
    if (!defined(white) || white > 3 || !defined(black) || black > 3) {
      return Result.err(new FenError(InvalidFen.RemainingChecks));
    }
    return Result.ok(new RemainingChecks(white, black));
  } else
    return Result.err(new FenError(InvalidFen.RemainingChecks));
};
var parseFen = (fen) => {
  const parts = fen.split(/[\s_]+/);
  const boardPart = parts.shift();
  let board2;
  let pockets = Result.ok(void 0);
  if (boardPart.endsWith("]")) {
    const pocketStart = boardPart.indexOf("[");
    if (pocketStart === -1)
      return Result.err(new FenError(InvalidFen.Fen));
    board2 = parseBoardFen(boardPart.slice(0, pocketStart));
    pockets = parsePockets(boardPart.slice(pocketStart + 1, -1));
  } else {
    const pocketStart = nthIndexOf(boardPart, "/", 7);
    if (pocketStart === -1)
      board2 = parseBoardFen(boardPart);
    else {
      board2 = parseBoardFen(boardPart.slice(0, pocketStart));
      pockets = parsePockets(boardPart.slice(pocketStart + 1));
    }
  }
  let turn;
  const turnPart = parts.shift();
  if (!defined(turnPart) || turnPart === "w")
    turn = "white";
  else if (turnPart === "b")
    turn = "black";
  else
    return Result.err(new FenError(InvalidFen.Turn));
  return board2.chain((board3) => {
    const castlingPart = parts.shift();
    const castlingRights = defined(castlingPart) ? parseCastlingFen(board3, castlingPart) : Result.ok(SquareSet.empty());
    const epPart = parts.shift();
    let epSquare;
    if (defined(epPart) && epPart !== "-") {
      epSquare = parseSquare(epPart);
      if (!defined(epSquare))
        return Result.err(new FenError(InvalidFen.EpSquare));
    }
    let halfmovePart = parts.shift();
    let earlyRemainingChecks;
    if (defined(halfmovePart) && halfmovePart.includes("+")) {
      earlyRemainingChecks = parseRemainingChecks(halfmovePart);
      halfmovePart = parts.shift();
    }
    const halfmoves = defined(halfmovePart) ? parseSmallUint(halfmovePart) : 0;
    if (!defined(halfmoves))
      return Result.err(new FenError(InvalidFen.Halfmoves));
    const fullmovesPart = parts.shift();
    const fullmoves = defined(fullmovesPart) ? parseSmallUint(fullmovesPart) : 1;
    if (!defined(fullmoves))
      return Result.err(new FenError(InvalidFen.Fullmoves));
    const remainingChecksPart = parts.shift();
    let remainingChecks = Result.ok(void 0);
    if (defined(remainingChecksPart)) {
      if (defined(earlyRemainingChecks))
        return Result.err(new FenError(InvalidFen.RemainingChecks));
      remainingChecks = parseRemainingChecks(remainingChecksPart);
    } else if (defined(earlyRemainingChecks)) {
      remainingChecks = earlyRemainingChecks;
    }
    if (parts.length > 0)
      return Result.err(new FenError(InvalidFen.Fen));
    return pockets.chain((pockets2) => castlingRights.chain((castlingRights2) => remainingChecks.map((remainingChecks2) => {
      return {
        board: board3,
        pockets: pockets2,
        turn,
        castlingRights: castlingRights2,
        remainingChecks: remainingChecks2,
        epSquare,
        halfmoves,
        fullmoves: Math.max(1, fullmoves)
      };
    })));
  });
};
var parsePiece = (str) => {
  if (!str)
    return;
  const piece2 = charToPiece(str[0]);
  if (!piece2)
    return;
  if (str.length === 2 && str[1] === "~")
    piece2.promoted = true;
  else if (str.length > 1)
    return;
  return piece2;
};
var makePiece = (piece2) => {
  let r = roleToChar(piece2.role);
  if (piece2.color === "white")
    r = r.toUpperCase();
  if (piece2.promoted)
    r += "~";
  return r;
};
var makeBoardFen = (board2) => {
  let fen = "";
  let empty = 0;
  for (let rank = 7; rank >= 0; rank--) {
    for (let file = 0; file < 8; file++) {
      const square2 = file + rank * 8;
      const piece2 = board2.get(square2);
      if (!piece2)
        empty++;
      else {
        if (empty > 0) {
          fen += empty;
          empty = 0;
        }
        fen += makePiece(piece2);
      }
      if (file === 7) {
        if (empty > 0) {
          fen += empty;
          empty = 0;
        }
        if (rank !== 0)
          fen += "/";
      }
    }
  }
  return fen;
};
var makePocket = (material) => ROLES.map((role) => roleToChar(role).repeat(material[role])).join("");
var makePockets = (pocket) => makePocket(pocket.white).toUpperCase() + makePocket(pocket.black);
var makeCastlingFen = (board2, castlingRights) => {
  let fen = "";
  for (const color of COLORS) {
    const backrank = SquareSet.backrank(color);
    let king = board2.kingOf(color);
    if (defined(king) && !backrank.has(king))
      king = void 0;
    const candidates = board2.pieces(color, "rook").intersect(backrank);
    for (const rook of castlingRights.intersect(backrank).reversed()) {
      if (rook === candidates.first() && defined(king) && rook < king) {
        fen += color === "white" ? "Q" : "q";
      } else if (rook === candidates.last() && defined(king) && king < rook) {
        fen += color === "white" ? "K" : "k";
      } else {
        const file = FILE_NAMES[squareFile(rook)];
        fen += color === "white" ? file.toUpperCase() : file;
      }
    }
  }
  return fen || "-";
};
var makeRemainingChecks = (checks) => `${checks.white}+${checks.black}`;
var makeFen = (setup, opts) => [
  makeBoardFen(setup.board) + (setup.pockets ? `[${makePockets(setup.pockets)}]` : ""),
  setup.turn[0],
  makeCastlingFen(setup.board, setup.castlingRights),
  defined(setup.epSquare) ? makeSquare(setup.epSquare) : "-",
  ...setup.remainingChecks ? [makeRemainingChecks(setup.remainingChecks)] : [],
  ...(opts === null || opts === void 0 ? void 0 : opts.epd) ? [] : [Math.max(0, Math.min(setup.halfmoves, 9999)), Math.max(1, Math.min(setup.fullmoves, 9999))]
].join(" ");

// node_modules/chessops/dist/esm/debug.js
var squareSet = (squares) => {
  const r = [];
  for (let y = 7; y >= 0; y--) {
    for (let x = 0; x < 8; x++) {
      const square2 = x + y * 8;
      r.push(squares.has(square2) ? "1" : ".");
      r.push(x < 7 ? " " : "\n");
    }
  }
  return r.join("");
};
var piece = (piece2) => makePiece(piece2);
var board = (board2) => {
  const r = [];
  for (let y = 7; y >= 0; y--) {
    for (let x = 0; x < 8; x++) {
      const square2 = x + y * 8;
      const p = board2.get(square2);
      const col = p ? piece(p) : ".";
      r.push(col);
      r.push(x < 7 ? col.length < 2 ? " " : "" : "\n");
    }
  }
  return r.join("");
};
var square = (sq) => makeSquare(sq);
var dests = (dests2) => {
  const lines = [];
  for (const [from, to] of dests2) {
    lines.push(`${makeSquare(from)}: ${Array.from(to, square).join(" ")}`);
  }
  return lines.join("\n");
};
var perft = (pos, depth, log = false) => {
  if (depth < 1)
    return 1;
  const promotionRoles = ["queen", "knight", "rook", "bishop"];
  if (pos.rules === "antichess")
    promotionRoles.push("king");
  const ctx = pos.ctx();
  const dropDests = pos.dropDests(ctx);
  if (!log && depth === 1 && dropDests.isEmpty()) {
    let nodes = 0;
    for (const [from, to] of pos.allDests(ctx)) {
      nodes += to.size();
      if (pos.board.pawn.has(from)) {
        const backrank = SquareSet.backrank(opposite(pos.turn));
        nodes += to.intersect(backrank).size() * (promotionRoles.length - 1);
      }
    }
    return nodes;
  } else {
    let nodes = 0;
    for (const [from, dests2] of pos.allDests(ctx)) {
      const promotions = squareRank(from) === (pos.turn === "white" ? 6 : 1) && pos.board.pawn.has(from) ? promotionRoles : [void 0];
      for (const to of dests2) {
        for (const promotion of promotions) {
          const child = pos.clone();
          const move = { from, to, promotion };
          child.play(move);
          const children = perft(child, depth - 1, false);
          if (log)
            console.log(makeUci(move), children);
          nodes += children;
        }
      }
    }
    if (pos.pockets) {
      for (const role of ROLES) {
        if (pos.pockets[pos.turn][role] > 0) {
          for (const to of role === "pawn" ? dropDests.diff(SquareSet.backranks()) : dropDests) {
            const child = pos.clone();
            const move = { role, to };
            child.play(move);
            const children = perft(child, depth - 1, false);
            if (log)
              console.log(makeUci(move), children);
            nodes += children;
          }
        }
      }
    }
    return nodes;
  }
};

// node_modules/chessops/dist/esm/san.js
var san_exports = {};
__export(san_exports, {
  makeSan: () => makeSan,
  makeSanAndPlay: () => makeSanAndPlay,
  makeSanVariation: () => makeSanVariation,
  parseSan: () => parseSan
});
var makeSanWithoutSuffix = (pos, move) => {
  let san = "";
  if (isDrop(move)) {
    if (move.role !== "pawn")
      san = roleToChar(move.role).toUpperCase();
    san += "@" + makeSquare(move.to);
  } else {
    const role = pos.board.getRole(move.from);
    if (!role)
      return "--";
    if (role === "king" && (pos.board[pos.turn].has(move.to) || Math.abs(move.to - move.from) === 2)) {
      san = move.to > move.from ? "O-O" : "O-O-O";
    } else {
      const capture = pos.board.occupied.has(move.to) || role === "pawn" && squareFile(move.from) !== squareFile(move.to);
      if (role !== "pawn") {
        san = roleToChar(role).toUpperCase();
        let others;
        if (role === "king")
          others = kingAttacks(move.to).intersect(pos.board.king);
        else if (role === "queen")
          others = queenAttacks(move.to, pos.board.occupied).intersect(pos.board.queen);
        else if (role === "rook")
          others = rookAttacks(move.to, pos.board.occupied).intersect(pos.board.rook);
        else if (role === "bishop")
          others = bishopAttacks(move.to, pos.board.occupied).intersect(pos.board.bishop);
        else
          others = knightAttacks(move.to).intersect(pos.board.knight);
        others = others.intersect(pos.board[pos.turn]).without(move.from);
        if (others.nonEmpty()) {
          const ctx = pos.ctx();
          for (const from of others) {
            if (!pos.dests(from, ctx).has(move.to))
              others = others.without(from);
          }
          if (others.nonEmpty()) {
            let row = false;
            let column = others.intersects(SquareSet.fromRank(squareRank(move.from)));
            if (others.intersects(SquareSet.fromFile(squareFile(move.from))))
              row = true;
            else
              column = true;
            if (column)
              san += FILE_NAMES[squareFile(move.from)];
            if (row)
              san += RANK_NAMES[squareRank(move.from)];
          }
        }
      } else if (capture)
        san = FILE_NAMES[squareFile(move.from)];
      if (capture)
        san += "x";
      san += makeSquare(move.to);
      if (move.promotion)
        san += "=" + roleToChar(move.promotion).toUpperCase();
    }
  }
  return san;
};
var makeSanAndPlay = (pos, move) => {
  var _a;
  const san = makeSanWithoutSuffix(pos, move);
  pos.play(move);
  if ((_a = pos.outcome()) === null || _a === void 0 ? void 0 : _a.winner)
    return san + "#";
  if (pos.isCheck())
    return san + "+";
  return san;
};
var makeSanVariation = (pos, variation) => {
  var _a;
  pos = pos.clone();
  const line = [];
  for (let i = 0; i < variation.length; i++) {
    if (i !== 0)
      line.push(" ");
    if (pos.turn === "white")
      line.push(pos.fullmoves, ". ");
    else if (i === 0)
      line.push(pos.fullmoves, "... ");
    const san = makeSanWithoutSuffix(pos, variation[i]);
    pos.play(variation[i]);
    line.push(san);
    if (san === "--")
      return line.join("");
    if (i === variation.length - 1 && ((_a = pos.outcome()) === null || _a === void 0 ? void 0 : _a.winner))
      line.push("#");
    else if (pos.isCheck())
      line.push("+");
  }
  return line.join("");
};
var makeSan = (pos, move) => makeSanAndPlay(pos.clone(), move);
var parseSan = (pos, san) => {
  const ctx = pos.ctx();
  const match = san.match(/^([NBRQK])?([a-h])?([1-8])?[-x]?([a-h][1-8])(?:=?([nbrqkNBRQK]))?[+#]?$/);
  if (!match) {
    let castlingSide2;
    if (san === "O-O" || san === "O-O+" || san === "O-O#")
      castlingSide2 = "h";
    else if (san === "O-O-O" || san === "O-O-O+" || san === "O-O-O#")
      castlingSide2 = "a";
    if (castlingSide2) {
      const rook = pos.castles.rook[pos.turn][castlingSide2];
      if (!defined(ctx.king) || !defined(rook) || !pos.dests(ctx.king, ctx).has(rook))
        return;
      return {
        from: ctx.king,
        to: rook
      };
    }
    const match2 = san.match(/^([pnbrqkPNBRQK])?@([a-h][1-8])[+#]?$/);
    if (!match2)
      return;
    const move = {
      role: match2[1] ? charToRole(match2[1]) : "pawn",
      to: parseSquare(match2[2])
    };
    return pos.isLegal(move, ctx) ? move : void 0;
  }
  const role = match[1] ? charToRole(match[1]) : "pawn";
  const to = parseSquare(match[4]);
  const promotion = match[5] ? charToRole(match[5]) : void 0;
  if (!!promotion !== (role === "pawn" && SquareSet.backranks().has(to)))
    return;
  if (promotion === "king" && pos.rules !== "antichess")
    return;
  let candidates = pos.board.pieces(pos.turn, role);
  if (role === "pawn" && !match[2])
    candidates = candidates.intersect(SquareSet.fromFile(squareFile(to)));
  else if (match[2])
    candidates = candidates.intersect(SquareSet.fromFile(match[2].charCodeAt(0) - "a".charCodeAt(0)));
  if (match[3])
    candidates = candidates.intersect(SquareSet.fromRank(match[3].charCodeAt(0) - "1".charCodeAt(0)));
  const pawnAdvance = role === "pawn" ? SquareSet.fromFile(squareFile(to)) : SquareSet.empty();
  candidates = candidates.intersect(pawnAdvance.union(attacks({ color: opposite(pos.turn), role }, to, pos.board.occupied)));
  let from;
  for (const candidate of candidates) {
    if (pos.dests(candidate, ctx).has(to)) {
      if (defined(from))
        return;
      from = candidate;
    }
  }
  if (!defined(from))
    return;
  return {
    from,
    to,
    promotion
  };
};

// node_modules/chessops/dist/esm/transform.js
var transform_exports = {};
__export(transform_exports, {
  flipDiagonal: () => flipDiagonal,
  flipHorizontal: () => flipHorizontal,
  flipVertical: () => flipVertical,
  rotate180: () => rotate180,
  shiftDown: () => shiftDown,
  shiftLeft: () => shiftLeft,
  shiftRight: () => shiftRight,
  shiftUp: () => shiftUp,
  transformBoard: () => transformBoard,
  transformSetup: () => transformSetup
});
var flipVertical = (s) => s.bswap64();
var flipHorizontal = (s) => {
  const k1 = new SquareSet(1431655765, 1431655765);
  const k2 = new SquareSet(858993459, 858993459);
  const k4 = new SquareSet(252645135, 252645135);
  s = s.shr64(1).intersect(k1).union(s.intersect(k1).shl64(1));
  s = s.shr64(2).intersect(k2).union(s.intersect(k2).shl64(2));
  s = s.shr64(4).intersect(k4).union(s.intersect(k4).shl64(4));
  return s;
};
var flipDiagonal = (s) => {
  let t = s.xor(s.shl64(28)).intersect(new SquareSet(0, 252645135));
  s = s.xor(t.xor(t.shr64(28)));
  t = s.xor(s.shl64(14)).intersect(new SquareSet(858980352, 858980352));
  s = s.xor(t.xor(t.shr64(14)));
  t = s.xor(s.shl64(7)).intersect(new SquareSet(1426085120, 1426085120));
  s = s.xor(t.xor(t.shr64(7)));
  return s;
};
var rotate180 = (s) => s.rbit64();
var shiftLeft = (squares) => squares.diff(SquareSet.fromFile(0)).shr64(1).union(squares.intersect(SquareSet.fromFile(0)).shl64(7));
var shiftRight = (squares) => squares.diff(SquareSet.fromFile(7)).shl64(1).union(squares.intersect(SquareSet.fromFile(7)).shr64(7));
var shiftDown = (squares) => squares.diff(SquareSet.fromRank(0)).shr64(8).union(squares.intersect(SquareSet.fromRank(0)).shl64(7 * 8));
var shiftUp = (squares) => squares.diff(SquareSet.fromRank(7)).shl64(8).union(squares.intersect(SquareSet.fromRank(7)).shr64(7 * 8));
var transformBoard = (board2, f) => {
  const b = Board.empty();
  b.occupied = f(board2.occupied);
  b.promoted = f(board2.promoted);
  for (const color of COLORS)
    b[color] = f(board2[color]);
  for (const role of ROLES)
    b[role] = f(board2[role]);
  return b;
};
var transformSetup = (setup, f) => {
  var _a, _b;
  return {
    board: transformBoard(setup.board, f),
    pockets: (_a = setup.pockets) === null || _a === void 0 ? void 0 : _a.clone(),
    turn: setup.turn,
    castlingRights: f(setup.castlingRights),
    epSquare: defined(setup.epSquare) ? f(SquareSet.fromSquare(setup.epSquare)).first() : void 0,
    remainingChecks: (_b = setup.remainingChecks) === null || _b === void 0 ? void 0 : _b.clone(),
    halfmoves: setup.halfmoves,
    fullmoves: setup.fullmoves
  };
};

// node_modules/chessops/dist/esm/variant.js
var variant_exports = {};
__export(variant_exports, {
  Antichess: () => Antichess,
  Atomic: () => Atomic,
  Castles: () => Castles,
  Chess: () => Chess,
  Crazyhouse: () => Crazyhouse,
  Horde: () => Horde,
  IllegalSetup: () => IllegalSetup,
  KingOfTheHill: () => KingOfTheHill,
  Position: () => Position,
  PositionError: () => PositionError,
  RacingKings: () => RacingKings,
  ThreeCheck: () => ThreeCheck,
  castlingSide: () => castlingSide,
  defaultPosition: () => defaultPosition,
  equalsIgnoreMoves: () => equalsIgnoreMoves,
  isImpossibleCheck: () => isImpossibleCheck,
  isStandardMaterial: () => isStandardMaterial,
  normalizeMove: () => normalizeMove,
  setupPosition: () => setupPosition
});
var Crazyhouse = class extends Position {
  constructor() {
    super("crazyhouse");
  }
  reset() {
    super.reset();
    this.pockets = Material.empty();
  }
  setupUnchecked(setup) {
    super.setupUnchecked(setup);
    this.board.promoted = setup.board.promoted.intersect(setup.board.occupied).diff(setup.board.king).diff(setup.board.pawn);
    this.pockets = setup.pockets ? setup.pockets.clone() : Material.empty();
  }
  static default() {
    const pos = new this();
    pos.reset();
    return pos;
  }
  static fromSetup(setup) {
    const pos = new this();
    pos.setupUnchecked(setup);
    return pos.validate().map((_) => pos);
  }
  clone() {
    return super.clone();
  }
  validate() {
    return super.validate().chain((_) => {
      var _a, _b;
      if ((_a = this.pockets) === null || _a === void 0 ? void 0 : _a.count("king")) {
        return Result.err(new PositionError(IllegalSetup.Kings));
      }
      if ((((_b = this.pockets) === null || _b === void 0 ? void 0 : _b.size()) || 0) + this.board.occupied.size() > 64) {
        return Result.err(new PositionError(IllegalSetup.Variant));
      }
      return Result.ok(void 0);
    });
  }
  hasInsufficientMaterial(color) {
    if (!this.pockets)
      return super.hasInsufficientMaterial(color);
    return this.board.occupied.size() + this.pockets.size() <= 3 && this.board.pawn.isEmpty() && this.board.promoted.isEmpty() && this.board.rooksAndQueens().isEmpty() && this.pockets.count("pawn") <= 0 && this.pockets.count("rook") <= 0 && this.pockets.count("queen") <= 0;
  }
  dropDests(ctx) {
    var _a, _b;
    const mask = this.board.occupied.complement().intersect(((_a = this.pockets) === null || _a === void 0 ? void 0 : _a[this.turn].hasNonPawns()) ? SquareSet.full() : ((_b = this.pockets) === null || _b === void 0 ? void 0 : _b[this.turn].hasPawns()) ? SquareSet.backranks().complement() : SquareSet.empty());
    ctx = ctx || this.ctx();
    if (defined(ctx.king) && ctx.checkers.nonEmpty()) {
      const checker = ctx.checkers.singleSquare();
      if (!defined(checker))
        return SquareSet.empty();
      return mask.intersect(between(checker, ctx.king));
    } else
      return mask;
  }
};
var Atomic = class extends Position {
  constructor() {
    super("atomic");
  }
  static default() {
    const pos = new this();
    pos.reset();
    return pos;
  }
  static fromSetup(setup) {
    const pos = new this();
    pos.setupUnchecked(setup);
    return pos.validate().map((_) => pos);
  }
  clone() {
    return super.clone();
  }
  validate() {
    if (this.board.occupied.isEmpty())
      return Result.err(new PositionError(IllegalSetup.Empty));
    if (this.board.king.size() > 2)
      return Result.err(new PositionError(IllegalSetup.Kings));
    const otherKing = this.board.kingOf(opposite(this.turn));
    if (!defined(otherKing))
      return Result.err(new PositionError(IllegalSetup.Kings));
    if (this.kingAttackers(otherKing, this.turn, this.board.occupied).nonEmpty()) {
      return Result.err(new PositionError(IllegalSetup.OppositeCheck));
    }
    if (SquareSet.backranks().intersects(this.board.pawn)) {
      return Result.err(new PositionError(IllegalSetup.PawnsOnBackrank));
    }
    return Result.ok(void 0);
  }
  kingAttackers(square2, attacker, occupied) {
    const attackerKings = this.board.pieces(attacker, "king");
    if (attackerKings.isEmpty() || kingAttacks(square2).intersects(attackerKings)) {
      return SquareSet.empty();
    }
    return super.kingAttackers(square2, attacker, occupied);
  }
  playCaptureAt(square2, captured) {
    super.playCaptureAt(square2, captured);
    this.board.take(square2);
    for (const explode of kingAttacks(square2).intersect(this.board.occupied).diff(this.board.pawn)) {
      const piece2 = this.board.take(explode);
      if ((piece2 === null || piece2 === void 0 ? void 0 : piece2.role) === "rook")
        this.castles.discardRook(explode);
      if ((piece2 === null || piece2 === void 0 ? void 0 : piece2.role) === "king")
        this.castles.discardColor(piece2.color);
    }
  }
  hasInsufficientMaterial(color) {
    if (this.board.pieces(opposite(color), "king").isEmpty())
      return false;
    if (this.board[color].diff(this.board.king).isEmpty())
      return true;
    if (this.board[opposite(color)].diff(this.board.king).nonEmpty()) {
      if (this.board.occupied.equals(this.board.bishop.union(this.board.king))) {
        if (!this.board.bishop.intersect(this.board.white).intersects(SquareSet.darkSquares())) {
          return !this.board.bishop.intersect(this.board.black).intersects(SquareSet.lightSquares());
        }
        if (!this.board.bishop.intersect(this.board.white).intersects(SquareSet.lightSquares())) {
          return !this.board.bishop.intersect(this.board.black).intersects(SquareSet.darkSquares());
        }
      }
      return false;
    }
    if (this.board.queen.nonEmpty() || this.board.pawn.nonEmpty())
      return false;
    if (this.board.knight.union(this.board.bishop).union(this.board.rook).size() === 1)
      return true;
    if (this.board.occupied.equals(this.board.knight.union(this.board.king))) {
      return this.board.knight.size() <= 2;
    }
    return false;
  }
  dests(square2, ctx) {
    ctx = ctx || this.ctx();
    let dests2 = SquareSet.empty();
    for (const to of pseudoDests(this, square2, ctx)) {
      const after = this.clone();
      after.play({ from: square2, to });
      const ourKing = after.board.kingOf(this.turn);
      if (defined(ourKing) && (!defined(after.board.kingOf(after.turn)) || after.kingAttackers(ourKing, after.turn, after.board.occupied).isEmpty())) {
        dests2 = dests2.with(to);
      }
    }
    return dests2;
  }
  isVariantEnd() {
    return !!this.variantOutcome();
  }
  variantOutcome(_ctx) {
    for (const color of COLORS) {
      if (this.board.pieces(color, "king").isEmpty())
        return { winner: opposite(color) };
    }
    return;
  }
};
var Antichess = class extends Position {
  constructor() {
    super("antichess");
  }
  reset() {
    super.reset();
    this.castles = Castles.empty();
  }
  setupUnchecked(setup) {
    super.setupUnchecked(setup);
    this.castles = Castles.empty();
  }
  static default() {
    const pos = new this();
    pos.reset();
    return pos;
  }
  static fromSetup(setup) {
    const pos = new this();
    pos.setupUnchecked(setup);
    return pos.validate().map((_) => pos);
  }
  clone() {
    return super.clone();
  }
  validate() {
    if (this.board.occupied.isEmpty())
      return Result.err(new PositionError(IllegalSetup.Empty));
    if (SquareSet.backranks().intersects(this.board.pawn)) {
      return Result.err(new PositionError(IllegalSetup.PawnsOnBackrank));
    }
    return Result.ok(void 0);
  }
  kingAttackers(_square, _attacker, _occupied) {
    return SquareSet.empty();
  }
  ctx() {
    const ctx = super.ctx();
    if (defined(this.epSquare) && pawnAttacks(opposite(this.turn), this.epSquare).intersects(this.board.pieces(this.turn, "pawn"))) {
      ctx.mustCapture = true;
      return ctx;
    }
    const enemy = this.board[opposite(this.turn)];
    for (const from of this.board[this.turn]) {
      if (pseudoDests(this, from, ctx).intersects(enemy)) {
        ctx.mustCapture = true;
        return ctx;
      }
    }
    return ctx;
  }
  dests(square2, ctx) {
    ctx = ctx || this.ctx();
    const dests2 = pseudoDests(this, square2, ctx);
    const enemy = this.board[opposite(this.turn)];
    return dests2.intersect(ctx.mustCapture ? defined(this.epSquare) && this.board.getRole(square2) === "pawn" ? enemy.with(this.epSquare) : enemy : SquareSet.full());
  }
  hasInsufficientMaterial(color) {
    if (this.board[color].isEmpty())
      return false;
    if (this.board[opposite(color)].isEmpty())
      return true;
    if (this.board.occupied.equals(this.board.bishop)) {
      const weSomeOnLight = this.board[color].intersects(SquareSet.lightSquares());
      const weSomeOnDark = this.board[color].intersects(SquareSet.darkSquares());
      const theyAllOnDark = this.board[opposite(color)].isDisjoint(SquareSet.lightSquares());
      const theyAllOnLight = this.board[opposite(color)].isDisjoint(SquareSet.darkSquares());
      return weSomeOnLight && theyAllOnDark || weSomeOnDark && theyAllOnLight;
    }
    if (this.board.occupied.equals(this.board.knight) && this.board.occupied.size() === 2) {
      return this.board.white.intersects(SquareSet.lightSquares()) !== this.board.black.intersects(SquareSet.darkSquares()) !== (this.turn === color);
    }
    return false;
  }
  isVariantEnd() {
    return this.board[this.turn].isEmpty();
  }
  variantOutcome(ctx) {
    ctx = ctx || this.ctx();
    if (ctx.variantEnd || this.isStalemate(ctx)) {
      return { winner: this.turn };
    }
    return;
  }
};
var KingOfTheHill = class extends Position {
  constructor() {
    super("kingofthehill");
  }
  static default() {
    const pos = new this();
    pos.reset();
    return pos;
  }
  static fromSetup(setup) {
    const pos = new this();
    pos.setupUnchecked(setup);
    return pos.validate().map((_) => pos);
  }
  clone() {
    return super.clone();
  }
  hasInsufficientMaterial(_color) {
    return false;
  }
  isVariantEnd() {
    return this.board.king.intersects(SquareSet.center());
  }
  variantOutcome(_ctx) {
    for (const color of COLORS) {
      if (this.board.pieces(color, "king").intersects(SquareSet.center()))
        return { winner: color };
    }
    return;
  }
};
var ThreeCheck = class extends Position {
  constructor() {
    super("3check");
  }
  reset() {
    super.reset();
    this.remainingChecks = RemainingChecks.default();
  }
  setupUnchecked(setup) {
    var _a;
    super.setupUnchecked(setup);
    this.remainingChecks = ((_a = setup.remainingChecks) === null || _a === void 0 ? void 0 : _a.clone()) || RemainingChecks.default();
  }
  static default() {
    const pos = new this();
    pos.reset();
    return pos;
  }
  static fromSetup(setup) {
    const pos = new this();
    pos.setupUnchecked(setup);
    return pos.validate().map((_) => pos);
  }
  clone() {
    return super.clone();
  }
  hasInsufficientMaterial(color) {
    return this.board.pieces(color, "king").equals(this.board[color]);
  }
  isVariantEnd() {
    return !!this.remainingChecks && (this.remainingChecks.white <= 0 || this.remainingChecks.black <= 0);
  }
  variantOutcome(_ctx) {
    if (this.remainingChecks) {
      for (const color of COLORS) {
        if (this.remainingChecks[color] <= 0)
          return { winner: color };
      }
    }
    return;
  }
};
var racingKingsBoard = () => {
  const board2 = Board.empty();
  board2.occupied = new SquareSet(65535, 0);
  board2.promoted = SquareSet.empty();
  board2.white = new SquareSet(61680, 0);
  board2.black = new SquareSet(3855, 0);
  board2.pawn = SquareSet.empty();
  board2.knight = new SquareSet(6168, 0);
  board2.bishop = new SquareSet(9252, 0);
  board2.rook = new SquareSet(16962, 0);
  board2.queen = new SquareSet(129, 0);
  board2.king = new SquareSet(33024, 0);
  return board2;
};
var RacingKings = class extends Position {
  constructor() {
    super("racingkings");
  }
  reset() {
    this.board = racingKingsBoard();
    this.pockets = void 0;
    this.turn = "white";
    this.castles = Castles.empty();
    this.epSquare = void 0;
    this.remainingChecks = void 0;
    this.halfmoves = 0;
    this.fullmoves = 1;
  }
  setupUnchecked(setup) {
    super.setupUnchecked(setup);
    this.castles = Castles.empty();
  }
  static default() {
    const pos = new this();
    pos.reset();
    return pos;
  }
  static fromSetup(setup) {
    const pos = new this();
    pos.setupUnchecked(setup);
    return pos.validate().map((_) => pos);
  }
  clone() {
    return super.clone();
  }
  validate() {
    if (this.isCheck() || this.board.pawn.nonEmpty())
      return Result.err(new PositionError(IllegalSetup.Variant));
    return super.validate();
  }
  dests(square2, ctx) {
    ctx = ctx || this.ctx();
    let dests2 = SquareSet.empty();
    for (const to of super.dests(square2, ctx)) {
      const move = { from: square2, to };
      const after = this.clone();
      after.play(move);
      if (!after.isCheck())
        dests2 = dests2.with(to);
    }
    return dests2;
  }
  hasInsufficientMaterial(_color) {
    return false;
  }
  isVariantEnd() {
    const goal = SquareSet.fromRank(7);
    const inGoal = this.board.king.intersect(goal);
    if (inGoal.isEmpty())
      return false;
    if (this.turn === "white" || inGoal.intersects(this.board.black))
      return true;
    const blackKing = this.board.kingOf("black");
    if (defined(blackKing)) {
      const occ = this.board.occupied.without(blackKing);
      for (const target of kingAttacks(blackKing).intersect(goal).diff(this.board.black)) {
        if (this.kingAttackers(target, "white", occ).isEmpty())
          return false;
      }
    }
    return true;
  }
  variantOutcome(ctx) {
    if (ctx ? !ctx.variantEnd : !this.isVariantEnd())
      return;
    const goal = SquareSet.fromRank(7);
    const blackInGoal = this.board.pieces("black", "king").intersects(goal);
    const whiteInGoal = this.board.pieces("white", "king").intersects(goal);
    if (blackInGoal && !whiteInGoal)
      return { winner: "black" };
    if (whiteInGoal && !blackInGoal)
      return { winner: "white" };
    return { winner: void 0 };
  }
};
var hordeBoard = () => {
  const board2 = Board.empty();
  board2.occupied = new SquareSet(4294967295, 4294901862);
  board2.promoted = SquareSet.empty();
  board2.white = new SquareSet(4294967295, 102);
  board2.black = new SquareSet(0, 4294901760);
  board2.pawn = new SquareSet(4294967295, 16711782);
  board2.knight = new SquareSet(0, 1107296256);
  board2.bishop = new SquareSet(0, 603979776);
  board2.rook = new SquareSet(0, 2164260864);
  board2.queen = new SquareSet(0, 134217728);
  board2.king = new SquareSet(0, 268435456);
  return board2;
};
var Horde = class extends Position {
  constructor() {
    super("horde");
  }
  reset() {
    this.board = hordeBoard();
    this.pockets = void 0;
    this.turn = "white";
    this.castles = Castles.default();
    this.castles.discardColor("white");
    this.epSquare = void 0;
    this.remainingChecks = void 0;
    this.halfmoves = 0;
    this.fullmoves = 1;
  }
  static default() {
    const pos = new this();
    pos.reset();
    return pos;
  }
  static fromSetup(setup) {
    const pos = new this();
    pos.setupUnchecked(setup);
    return pos.validate().map((_) => pos);
  }
  clone() {
    return super.clone();
  }
  validate() {
    if (this.board.occupied.isEmpty())
      return Result.err(new PositionError(IllegalSetup.Empty));
    if (this.board.king.size() !== 1)
      return Result.err(new PositionError(IllegalSetup.Kings));
    const otherKing = this.board.kingOf(opposite(this.turn));
    if (defined(otherKing) && this.kingAttackers(otherKing, this.turn, this.board.occupied).nonEmpty()) {
      return Result.err(new PositionError(IllegalSetup.OppositeCheck));
    }
    for (const color of COLORS) {
      const backranks = this.board.pieces(color, "king").isEmpty() ? SquareSet.backrank(opposite(color)) : SquareSet.backranks();
      if (this.board.pieces(color, "pawn").intersects(backranks)) {
        return Result.err(new PositionError(IllegalSetup.PawnsOnBackrank));
      }
    }
    return Result.ok(void 0);
  }
  hasInsufficientMaterial(color) {
    if (this.board.pieces(color, "king").nonEmpty())
      return false;
    const oppositeSquareColor = (squareColor) => squareColor === "light" ? "dark" : "light";
    const coloredSquares = (squareColor) => squareColor === "light" ? SquareSet.lightSquares() : SquareSet.darkSquares();
    const hasBishopPair = (side) => {
      const bishops = this.board.pieces(side, "bishop");
      return bishops.intersects(SquareSet.darkSquares()) && bishops.intersects(SquareSet.lightSquares());
    };
    const horde = MaterialSide.fromBoard(this.board, color);
    const hordeBishops = (squareColor) => coloredSquares(squareColor).intersect(this.board.pieces(color, "bishop")).size();
    const hordeBishopColor = hordeBishops("light") >= 1 ? "light" : "dark";
    const hordeNum = horde.pawn + horde.knight + horde.rook + horde.queen + Math.min(hordeBishops("dark"), 2) + Math.min(hordeBishops("light"), 2);
    const pieces = MaterialSide.fromBoard(this.board, opposite(color));
    const piecesBishops = (squareColor) => coloredSquares(squareColor).intersect(this.board.pieces(opposite(color), "bishop")).size();
    const piecesNum = pieces.size();
    const piecesOfRoleNot = (piece2) => piecesNum - piece2;
    if (hordeNum === 0)
      return true;
    if (hordeNum >= 4) {
      return false;
    }
    if ((horde.pawn >= 1 || horde.queen >= 1) && hordeNum >= 2) {
      return false;
    }
    if (horde.rook >= 1 && hordeNum >= 2) {
      if (!(hordeNum === 2 && horde.rook === 1 && horde.bishop === 1 && piecesOfRoleNot(piecesBishops(hordeBishopColor)) === 1)) {
        return false;
      }
    }
    if (hordeNum === 1) {
      if (piecesNum === 1) {
        return true;
      } else if (horde.queen === 1) {
        return !(pieces.pawn >= 1 || pieces.rook >= 1 || piecesBishops("light") >= 2 || piecesBishops("dark") >= 2);
      } else if (horde.pawn === 1) {
        const pawnSquare = this.board.pieces(color, "pawn").last();
        const promoteToQueen = this.clone();
        promoteToQueen.board.set(pawnSquare, { color, role: "queen" });
        const promoteToKnight = this.clone();
        promoteToKnight.board.set(pawnSquare, { color, role: "knight" });
        return promoteToQueen.hasInsufficientMaterial(color) && promoteToKnight.hasInsufficientMaterial(color);
      } else if (horde.rook === 1) {
        return !(pieces.pawn >= 2 || pieces.rook >= 1 && pieces.pawn >= 1 || pieces.rook >= 1 && pieces.knight >= 1 || pieces.pawn >= 1 && pieces.knight >= 1);
      } else if (horde.bishop === 1) {
        return !// The king can be mated on A1 if there is a pawn/opposite-color-bishop
        // on A2 and an opposite-color-bishop on B1.
        // If black has two or more pawns, white gets the benefit of the doubt;
        // there is an outside chance that white promotes its pawns to
        // opposite-color-bishops and selfmates theirself.
        // Every other case that the king is mated by the bishop requires that
        // black has two pawns or two opposite-color-bishop or a pawn and an
        // opposite-color-bishop.
        // For example a king on A3 can be mated if there is
        // a pawn/opposite-color-bishop on A4, a pawn/opposite-color-bishop on
        // B3, a pawn/bishop/rook/queen on A2 and any other piece on B2.
        (piecesBishops(oppositeSquareColor(hordeBishopColor)) >= 2 || piecesBishops(oppositeSquareColor(hordeBishopColor)) >= 1 && pieces.pawn >= 1 || pieces.pawn >= 2);
      } else if (horde.knight === 1) {
        return !// The king on A1 can be smother mated by a knight on C2 if there is
        // a pawn/knight/bishop on B2, a knight/rook on B1 and any other piece
        // on A2.
        // Moreover, when black has four or more pieces and two of them are
        // pawns, black can promote their pawns and selfmate theirself.
        (piecesNum >= 4 && (pieces.knight >= 2 || pieces.pawn >= 2 || pieces.rook >= 1 && pieces.knight >= 1 || pieces.rook >= 1 && pieces.bishop >= 1 || pieces.knight >= 1 && pieces.bishop >= 1 || pieces.rook >= 1 && pieces.pawn >= 1 || pieces.knight >= 1 && pieces.pawn >= 1 || pieces.bishop >= 1 && pieces.pawn >= 1 || hasBishopPair(opposite(color)) && pieces.pawn >= 1) && (piecesBishops("dark") < 2 || piecesOfRoleNot(piecesBishops("dark")) >= 3) && (piecesBishops("light") < 2 || piecesOfRoleNot(piecesBishops("light")) >= 3));
      }
    } else if (hordeNum === 2) {
      if (piecesNum === 1) {
        return true;
      } else if (horde.knight === 2) {
        return pieces.pawn + pieces.bishop + pieces.knight < 1;
      } else if (hasBishopPair(color)) {
        return !// A king on A1 obstructed by a pawn/bishop on A2 is mated
        // by the bishop pair.
        (pieces.pawn >= 1 || pieces.bishop >= 1 || pieces.knight >= 1 && pieces.rook + pieces.queen >= 1);
      } else if (horde.bishop >= 1 && horde.knight >= 1) {
        return !// A king on A1 obstructed by a pawn/opposite-color-bishop on
        // A2 is mated by a knight on D2 and a bishop on C3.
        (pieces.pawn >= 1 || piecesBishops(oppositeSquareColor(hordeBishopColor)) >= 1 || piecesOfRoleNot(piecesBishops(hordeBishopColor)) >= 3);
      } else {
        return !// A king on A1 obstructed by a pawn/opposite-bishop/knight
        // on A2 and a opposite-bishop/knight on B1 is mated by two
        // bishops on B2 and C3. This position is theoretically
        // achievable even when black has two pawns or when they
        // have a pawn and an opposite color bishop.
        (pieces.pawn >= 1 && piecesBishops(oppositeSquareColor(hordeBishopColor)) >= 1 || pieces.pawn >= 1 && pieces.knight >= 1 || piecesBishops(oppositeSquareColor(hordeBishopColor)) >= 1 && pieces.knight >= 1 || piecesBishops(oppositeSquareColor(hordeBishopColor)) >= 2 || pieces.knight >= 2 || pieces.pawn >= 2);
      }
    } else if (hordeNum === 3) {
      if (horde.knight === 2 && horde.bishop === 1 || horde.knight === 3 || hasBishopPair(color)) {
        return false;
      } else {
        return piecesNum === 1;
      }
    }
    return true;
  }
  isVariantEnd() {
    return this.board.white.isEmpty() || this.board.black.isEmpty();
  }
  variantOutcome(_ctx) {
    if (this.board.white.isEmpty())
      return { winner: "black" };
    if (this.board.black.isEmpty())
      return { winner: "white" };
    return;
  }
};
var defaultPosition = (rules) => {
  switch (rules) {
    case "chess":
      return Chess.default();
    case "antichess":
      return Antichess.default();
    case "atomic":
      return Atomic.default();
    case "horde":
      return Horde.default();
    case "racingkings":
      return RacingKings.default();
    case "kingofthehill":
      return KingOfTheHill.default();
    case "3check":
      return ThreeCheck.default();
    case "crazyhouse":
      return Crazyhouse.default();
  }
};
var setupPosition = (rules, setup) => {
  switch (rules) {
    case "chess":
      return Chess.fromSetup(setup);
    case "antichess":
      return Antichess.fromSetup(setup);
    case "atomic":
      return Atomic.fromSetup(setup);
    case "horde":
      return Horde.fromSetup(setup);
    case "racingkings":
      return RacingKings.fromSetup(setup);
    case "kingofthehill":
      return KingOfTheHill.fromSetup(setup);
    case "3check":
      return ThreeCheck.fromSetup(setup);
    case "crazyhouse":
      return Crazyhouse.fromSetup(setup);
  }
};
var isStandardMaterial = (pos) => {
  var _a, _b, _c, _d, _e;
  switch (pos.rules) {
    case "chess":
    case "antichess":
    case "atomic":
    case "kingofthehill":
    case "3check":
      return COLORS.every((color) => isStandardMaterialSide(pos.board, color));
    case "crazyhouse": {
      const promoted = pos.board.promoted;
      return promoted.size() + pos.board.pawn.size() + (((_a = pos.pockets) === null || _a === void 0 ? void 0 : _a.count("pawn")) || 0) <= 16 && pos.board.knight.diff(promoted).size() + (((_b = pos.pockets) === null || _b === void 0 ? void 0 : _b.count("knight")) || 0) <= 4 && pos.board.bishop.diff(promoted).size() + (((_c = pos.pockets) === null || _c === void 0 ? void 0 : _c.count("bishop")) || 0) <= 4 && pos.board.rook.diff(promoted).size() + (((_d = pos.pockets) === null || _d === void 0 ? void 0 : _d.count("rook")) || 0) <= 4 && pos.board.queen.diff(promoted).size() + (((_e = pos.pockets) === null || _e === void 0 ? void 0 : _e.count("queen")) || 0) <= 2;
    }
    case "horde":
      return COLORS.every((color) => pos.board.pieces(color, "king").nonEmpty() ? isStandardMaterialSide(pos.board, color) : pos.board[color].size() <= 36);
    case "racingkings":
      return COLORS.every((color) => pos.board.pieces(color, "knight").size() <= 2 && pos.board.pieces(color, "bishop").size() <= 2 && pos.board.pieces(color, "rook").size() <= 2 && pos.board.pieces(color, "queen").size() <= 1);
  }
};

// node_modules/chessops/dist/esm/pgn.js
var pgn_exports = {};
__export(pgn_exports, {
  Box: () => Box,
  ChildNode: () => ChildNode,
  Node: () => Node,
  PgnError: () => PgnError,
  PgnParser: () => PgnParser,
  defaultGame: () => defaultGame,
  defaultHeaders: () => defaultHeaders,
  emptyHeaders: () => emptyHeaders,
  extend: () => extend,
  isChildNode: () => isChildNode,
  isMate: () => isMate,
  isPawns: () => isPawns,
  makeComment: () => makeComment,
  makeOutcome: () => makeOutcome,
  makePgn: () => makePgn,
  makeVariant: () => makeVariant,
  parseComment: () => parseComment,
  parseOutcome: () => parseOutcome,
  parsePgn: () => parsePgn,
  parseVariant: () => parseVariant,
  setStartingPosition: () => setStartingPosition,
  startingPosition: () => startingPosition,
  transform: () => transform,
  walk: () => walk
});
var defaultGame = (initHeaders = defaultHeaders) => ({
  headers: initHeaders(),
  moves: new Node()
});
var Node = class {
  constructor() {
    this.children = [];
  }
  *mainlineNodes() {
    let node = this;
    while (node.children.length) {
      const child = node.children[0];
      yield child;
      node = child;
    }
  }
  *mainline() {
    for (const child of this.mainlineNodes())
      yield child.data;
  }
  end() {
    let node = this;
    while (node.children.length)
      node = node.children[0];
    return node;
  }
};
var ChildNode = class extends Node {
  constructor(data) {
    super();
    this.data = data;
  }
};
var isChildNode = (node) => node instanceof ChildNode;
var extend = (node, data) => {
  for (const d of data) {
    const child = new ChildNode(d);
    node.children.push(child);
    node = child;
  }
  return node;
};
var Box = class _Box {
  constructor(value) {
    this.value = value;
  }
  clone() {
    return new _Box(this.value);
  }
};
var transform = (node, ctx, f) => {
  const root = new Node();
  const stack = [
    {
      before: node,
      after: root,
      ctx
    }
  ];
  let frame;
  while (frame = stack.pop()) {
    for (let childIndex = 0; childIndex < frame.before.children.length; childIndex++) {
      const ctx2 = childIndex < frame.before.children.length - 1 ? frame.ctx.clone() : frame.ctx;
      const childBefore = frame.before.children[childIndex];
      const data = f(ctx2, childBefore.data, childIndex);
      if (defined(data)) {
        const childAfter = new ChildNode(data);
        frame.after.children.push(childAfter);
        stack.push({
          before: childBefore,
          after: childAfter,
          ctx: ctx2
        });
      }
    }
  }
  return root;
};
var walk = (node, ctx, f) => {
  const stack = [{ node, ctx }];
  let frame;
  while (frame = stack.pop()) {
    for (let childIndex = 0; childIndex < frame.node.children.length; childIndex++) {
      const ctx2 = childIndex < frame.node.children.length - 1 ? frame.ctx.clone() : frame.ctx;
      const child = frame.node.children[childIndex];
      if (f(ctx2, child.data, childIndex) !== false)
        stack.push({ node: child, ctx: ctx2 });
    }
  }
};
var makeOutcome = (outcome) => {
  if (!outcome)
    return "*";
  else if (outcome.winner === "white")
    return "1-0";
  else if (outcome.winner === "black")
    return "0-1";
  else
    return "1/2-1/2";
};
var parseOutcome = (s) => {
  if (s === "1-0" || s === "1\u20130" || s === "1\u20140")
    return { winner: "white" };
  else if (s === "0-1" || s === "0\u20131" || s === "0\u20141")
    return { winner: "black" };
  else if (s === "1/2-1/2" || s === "1/2\u20131/2" || s === "1/2\u20141/2")
    return { winner: void 0 };
  else
    return;
};
var escapeHeader = (value) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
var safeComment = (comment) => comment.replace(/\}/g, "");
var makePgn = (game) => {
  const builder = [], tokens = [];
  if (game.headers.size) {
    for (const [key, value] of game.headers.entries()) {
      builder.push("[", key, ' "', escapeHeader(value), '"]\n');
    }
    builder.push("\n");
  }
  for (const comment of game.comments || [])
    tokens.push("{", safeComment(comment), "}");
  const fen = game.headers.get("FEN");
  const initialPly = fen ? parseFen(fen).unwrap((setup) => (setup.fullmoves - 1) * 2 + (setup.turn === "white" ? 0 : 1), (_) => 0) : 0;
  const stack = [];
  const variations = game.moves.children[Symbol.iterator]();
  const firstVariation = variations.next();
  if (!firstVariation.done) {
    stack.push({
      state: 0,
      ply: initialPly,
      node: firstVariation.value,
      sidelines: variations,
      startsVariation: false,
      inVariation: false
    });
  }
  let forceMoveNumber = true;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.inVariation) {
      tokens.push(")");
      frame.inVariation = false;
      forceMoveNumber = true;
    }
    switch (frame.state) {
      case 0:
        for (const comment of frame.node.data.startingComments || []) {
          tokens.push("{", safeComment(comment), "}");
          forceMoveNumber = true;
        }
        if (forceMoveNumber || frame.ply % 2 === 0) {
          tokens.push(Math.floor(frame.ply / 2) + 1 + (frame.ply % 2 ? "..." : "."));
          forceMoveNumber = false;
        }
        tokens.push(frame.node.data.san);
        for (const nag of frame.node.data.nags || []) {
          tokens.push("$" + nag);
          forceMoveNumber = true;
        }
        for (const comment of frame.node.data.comments || []) {
          tokens.push("{", safeComment(comment), "}");
        }
        frame.state = 1;
      // fall through
      case 1: {
        const child = frame.sidelines.next();
        if (child.done) {
          const variations2 = frame.node.children[Symbol.iterator]();
          const firstVariation2 = variations2.next();
          if (!firstVariation2.done) {
            stack.push({
              state: 0,
              ply: frame.ply + 1,
              node: firstVariation2.value,
              sidelines: variations2,
              startsVariation: false,
              inVariation: false
            });
          }
          frame.state = 2;
        } else {
          tokens.push("(");
          forceMoveNumber = true;
          stack.push({
            state: 0,
            ply: frame.ply,
            node: child.value,
            sidelines: [][Symbol.iterator](),
            startsVariation: true,
            inVariation: false
          });
          frame.inVariation = true;
        }
        break;
      }
      case 2:
        stack.pop();
    }
  }
  tokens.push(makeOutcome(parseOutcome(game.headers.get("Result"))));
  builder.push(tokens.join(" "), "\n");
  return builder.join("");
};
var defaultHeaders = () => /* @__PURE__ */ new Map([
  ["Event", "?"],
  ["Site", "?"],
  ["Date", "????.??.??"],
  ["Round", "?"],
  ["White", "?"],
  ["Black", "?"],
  ["Result", "*"]
]);
var emptyHeaders = () => /* @__PURE__ */ new Map();
var BOM = "\uFEFF";
var isWhitespace = (line) => /^\s*$/.test(line);
var isCommentLine = (line) => line.startsWith("%");
var PgnError = class extends Error {
};
var PgnParser = class {
  constructor(emitGame, initHeaders = defaultHeaders, maxBudget = 1e6) {
    this.emitGame = emitGame;
    this.initHeaders = initHeaders;
    this.maxBudget = maxBudget;
    this.lineBuf = [];
    this.resetGame();
    this.state = 0;
  }
  resetGame() {
    this.budget = this.maxBudget;
    this.found = false;
    this.state = 1;
    this.game = defaultGame(this.initHeaders);
    this.stack = [{ parent: this.game.moves, root: true }];
    this.commentBuf = [];
  }
  consumeBudget(cost) {
    this.budget -= cost;
    if (this.budget < 0)
      throw new PgnError("ERR_PGN_BUDGET");
  }
  parse(data, options) {
    if (this.budget < 0)
      return;
    try {
      let idx = 0;
      for (; ; ) {
        const nlIdx = data.indexOf("\n", idx);
        if (nlIdx === -1) {
          break;
        }
        const crIdx = nlIdx > idx && data[nlIdx - 1] === "\r" ? nlIdx - 1 : nlIdx;
        this.consumeBudget(nlIdx - idx);
        this.lineBuf.push(data.slice(idx, crIdx));
        idx = nlIdx + 1;
        this.handleLine();
      }
      this.consumeBudget(data.length - idx);
      this.lineBuf.push(data.slice(idx));
      if (!(options === null || options === void 0 ? void 0 : options.stream)) {
        this.handleLine();
        this.emit(void 0);
      }
    } catch (err) {
      this.emit(err);
    }
  }
  handleLine() {
    let freshLine = true;
    let line = this.lineBuf.join("");
    this.lineBuf = [];
    continuedLine: for (; ; ) {
      switch (this.state) {
        case 0:
          if (line.startsWith(BOM))
            line = line.slice(BOM.length);
          this.state = 1;
        // fall through
        case 1:
          if (isWhitespace(line) || isCommentLine(line))
            return;
          this.found = true;
          this.state = 2;
        // fall through
        case 2: {
          if (isCommentLine(line))
            return;
          let moreHeaders = true;
          while (moreHeaders) {
            moreHeaders = false;
            line = line.replace(/^\s*\[([A-Za-z0-9][A-Za-z0-9_+#=:-]*)\s+"((?:[^"\\]|\\"|\\\\)*)"\]/, (_match, headerName, headerValue) => {
              this.consumeBudget(200);
              this.handleHeader(headerName, headerValue.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
              moreHeaders = true;
              freshLine = false;
              return "";
            });
          }
          if (isWhitespace(line))
            return;
          this.state = 3;
        }
        case 3: {
          if (freshLine) {
            if (isCommentLine(line))
              return;
            if (isWhitespace(line))
              return this.emit(void 0);
          }
          const tokenRegex = /(?:[NBKRQ]?[a-h]?[1-8]?[-x]?[a-h][1-8](?:=?[nbrqkNBRQK])?|[pnbrqkPNBRQK]?@[a-h][1-8]|[O0o][-–—][O0o](?:[-–—][O0o])?)[+#]?|--|Z0|0000|@@@@|{|;|\$\d{1,4}|[?!]{1,2}|\(|\)|\*|1[-–—]0|0[-–—]1|1\/2[-–—]1\/2/g;
          let match;
          while (match = tokenRegex.exec(line)) {
            const frame = this.stack[this.stack.length - 1];
            let token = match[0];
            if (token === ";")
              return;
            else if (token.startsWith("$"))
              this.handleNag(parseInt(token.slice(1), 10));
            else if (token === "!")
              this.handleNag(1);
            else if (token === "?")
              this.handleNag(2);
            else if (token === "!!")
              this.handleNag(3);
            else if (token === "??")
              this.handleNag(4);
            else if (token === "!?")
              this.handleNag(5);
            else if (token === "?!")
              this.handleNag(6);
            else if (token === "1-0" || token === "1\u20130" || token === "1\u20140" || token === "0-1" || token === "0\u20131" || token === "0\u20141" || token === "1/2-1/2" || token === "1/2\u20131/2" || token === "1/2\u20141/2" || token === "*") {
              if (this.stack.length === 1 && token !== "*")
                this.handleHeader("Result", token);
            } else if (token === "(") {
              this.consumeBudget(100);
              this.stack.push({ parent: frame.parent, root: false });
            } else if (token === ")") {
              if (this.stack.length > 1)
                this.stack.pop();
            } else if (token === "{") {
              const openIndex = tokenRegex.lastIndex;
              const beginIndex = line[openIndex] === " " ? openIndex + 1 : openIndex;
              line = line.slice(beginIndex);
              this.state = 4;
              continue continuedLine;
            } else {
              this.consumeBudget(100);
              if (token.startsWith("O") || token.startsWith("0") || token.startsWith("o")) {
                token = token.replace(/[0o]/g, "O").replace(/[–—]/g, "-");
              } else if (token === "Z0" || token === "0000" || token === "@@@@")
                token = "--";
              if (frame.node)
                frame.parent = frame.node;
              frame.node = new ChildNode({
                san: token,
                startingComments: frame.startingComments
              });
              frame.startingComments = void 0;
              frame.root = false;
              frame.parent.children.push(frame.node);
            }
          }
          return;
        }
        case 4: {
          const closeIndex = line.indexOf("}");
          if (closeIndex === -1) {
            this.commentBuf.push(line);
            return;
          } else {
            const endIndex = closeIndex > 0 && line[closeIndex - 1] === " " ? closeIndex - 1 : closeIndex;
            this.commentBuf.push(line.slice(0, endIndex));
            this.handleComment();
            line = line.slice(closeIndex);
            this.state = 3;
            freshLine = false;
          }
        }
      }
    }
  }
  handleHeader(name, value) {
    this.game.headers.set(name, name === "Result" ? makeOutcome(parseOutcome(value)) : value);
  }
  handleNag(nag) {
    var _a;
    this.consumeBudget(50);
    const frame = this.stack[this.stack.length - 1];
    if (frame.node) {
      (_a = frame.node.data).nags || (_a.nags = []);
      frame.node.data.nags.push(nag);
    }
  }
  handleComment() {
    var _a, _b;
    this.consumeBudget(100);
    const frame = this.stack[this.stack.length - 1];
    const comment = this.commentBuf.join("\n");
    this.commentBuf = [];
    if (frame.node) {
      (_a = frame.node.data).comments || (_a.comments = []);
      frame.node.data.comments.push(comment);
    } else if (frame.root) {
      (_b = this.game).comments || (_b.comments = []);
      this.game.comments.push(comment);
    } else {
      frame.startingComments || (frame.startingComments = []);
      frame.startingComments.push(comment);
    }
  }
  emit(err) {
    if (this.state === 4)
      this.handleComment();
    if (err)
      return this.emitGame(this.game, err);
    if (this.found)
      this.emitGame(this.game, void 0);
    this.resetGame();
  }
};
var parsePgn = (pgn, initHeaders = defaultHeaders) => {
  const games = [];
  new PgnParser((game) => games.push(game), initHeaders, NaN).parse(pgn);
  return games;
};
var parseVariant = (variant) => {
  switch ((variant || "chess").toLowerCase()) {
    case "chess":
    case "chess960":
    case "chess 960":
    case "standard":
    case "from position":
    case "classical":
    case "normal":
    case "fischerandom":
    // Cute Chess
    case "fischerrandom":
    case "fischer random":
    case "wild/0":
    case "wild/1":
    case "wild/2":
    case "wild/3":
    case "wild/4":
    case "wild/5":
    case "wild/6":
    case "wild/7":
    case "wild/8":
    case "wild/8a":
      return "chess";
    case "crazyhouse":
    case "crazy house":
    case "house":
    case "zh":
      return "crazyhouse";
    case "king of the hill":
    case "koth":
    case "kingofthehill":
      return "kingofthehill";
    case "three-check":
    case "three check":
    case "threecheck":
    case "three check chess":
    case "3-check":
    case "3 check":
    case "3check":
      return "3check";
    case "antichess":
    case "anti chess":
    case "anti":
      return "antichess";
    case "atomic":
    case "atom":
    case "atomic chess":
      return "atomic";
    case "horde":
    case "horde chess":
      return "horde";
    case "racing kings":
    case "racingkings":
    case "racing":
    case "race":
      return "racingkings";
    default:
      return;
  }
};
var makeVariant = (rules) => {
  switch (rules) {
    case "chess":
      return;
    case "crazyhouse":
      return "Crazyhouse";
    case "racingkings":
      return "Racing Kings";
    case "horde":
      return "Horde";
    case "atomic":
      return "Atomic";
    case "antichess":
      return "Antichess";
    case "3check":
      return "Three-check";
    case "kingofthehill":
      return "King of the Hill";
  }
};
var startingPosition = (headers) => {
  const rules = parseVariant(headers.get("Variant"));
  if (!rules)
    return Result.err(new PositionError(IllegalSetup.Variant));
  const fen = headers.get("FEN");
  if (fen)
    return parseFen(fen).chain((setup) => setupPosition(rules, setup));
  else
    return Result.ok(defaultPosition(rules));
};
var setStartingPosition = (headers, pos) => {
  const variant = makeVariant(pos.rules);
  if (variant)
    headers.set("Variant", variant);
  else
    headers.delete("Variant");
  const fen = makeFen(pos.toSetup());
  const defaultFen = makeFen(defaultPosition(pos.rules).toSetup());
  if (fen !== defaultFen)
    headers.set("FEN", fen);
  else
    headers.delete("FEN");
};
var isPawns = (ev) => "pawns" in ev;
var isMate = (ev) => "mate" in ev;
var makeClk = (seconds) => {
  seconds = Math.max(0, seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  seconds = seconds % 3600 % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toLocaleString("en", {
    minimumIntegerDigits: 2,
    maximumFractionDigits: 3
  })}`;
};
var makeCommentShapeColor = (color) => {
  switch (color) {
    case "green":
      return "G";
    case "red":
      return "R";
    case "yellow":
      return "Y";
    case "blue":
      return "B";
  }
};
function parseCommentShapeColor(str) {
  switch (str) {
    case "G":
      return "green";
    case "R":
      return "red";
    case "Y":
      return "yellow";
    case "B":
      return "blue";
    default:
      return;
  }
}
var makeCommentShape = (shape) => shape.to === shape.from ? `${makeCommentShapeColor(shape.color)}${makeSquare(shape.to)}` : `${makeCommentShapeColor(shape.color)}${makeSquare(shape.from)}${makeSquare(shape.to)}`;
var parseCommentShape = (str) => {
  const color = parseCommentShapeColor(str.slice(0, 1));
  const from = parseSquare(str.slice(1, 3));
  const to = parseSquare(str.slice(3, 5));
  if (!color || !defined(from))
    return;
  if (str.length === 3)
    return { color, from, to: from };
  if (str.length === 5 && defined(to))
    return { color, from, to };
  return;
};
var makeEval = (ev) => {
  const str = isMate(ev) ? "#" + ev.mate : ev.pawns.toFixed(2);
  return defined(ev.depth) ? str + "," + ev.depth : str;
};
var makeComment = (comment) => {
  const builder = [];
  if (defined(comment.text))
    builder.push(comment.text);
  const circles = (comment.shapes || []).filter((shape) => shape.to === shape.from).map(makeCommentShape);
  if (circles.length)
    builder.push(`[%csl ${circles.join(",")}]`);
  const arrows = (comment.shapes || []).filter((shape) => shape.to !== shape.from).map(makeCommentShape);
  if (arrows.length)
    builder.push(`[%cal ${arrows.join(",")}]`);
  if (comment.evaluation)
    builder.push(`[%eval ${makeEval(comment.evaluation)}]`);
  if (defined(comment.emt))
    builder.push(`[%emt ${makeClk(comment.emt)}]`);
  if (defined(comment.clock))
    builder.push(`[%clk ${makeClk(comment.clock)}]`);
  return builder.join(" ");
};
var parseComment = (comment) => {
  let emt, clock, evaluation;
  const shapes = [];
  const text = comment.replace(/\s?\[%(emt|clk)\s(\d{1,5}):(\d{1,2}):(\d{1,2}(?:\.\d{0,3})?)\]\s?/g, (_, annotation, hours, minutes, seconds) => {
    const value = parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseFloat(seconds);
    if (annotation === "emt")
      emt = value;
    else if (annotation === "clk")
      clock = value;
    return "  ";
  }).replace(/\s?\[%(?:csl|cal)\s([RGYB][a-h][1-8](?:[a-h][1-8])?(?:,[RGYB][a-h][1-8](?:[a-h][1-8])?)*)\]\s?/g, (_, arrows) => {
    for (const arrow of arrows.split(",")) {
      shapes.push(parseCommentShape(arrow));
    }
    return "  ";
  }).replace(/\s?\[%eval\s(?:#([+-]?\d{1,5})|([+-]?(?:\d{1,5}|\d{0,5}\.\d{1,2})))(?:,(\d{1,5}))?\]\s?/g, (_, mate, pawns, d) => {
    const depth = d && parseInt(d, 10);
    evaluation = mate ? { mate: parseInt(mate, 10), depth } : { pawns: parseFloat(pawns), depth };
    return "  ";
  }).trim();
  return {
    text,
    shapes,
    emt,
    clock,
    evaluation
  };
};
export {
  Board,
  CASTLING_SIDES,
  COLORS,
  Castles,
  Chess,
  EMPTY_BOARD_FEN,
  EMPTY_EPD,
  EMPTY_FEN,
  FILE_NAMES,
  FenError,
  INITIAL_BOARD_FEN,
  INITIAL_EPD,
  INITIAL_FEN,
  IllegalSetup,
  InvalidFen,
  Material,
  MaterialSide,
  Position,
  PositionError,
  RANK_NAMES,
  ROLES,
  ROLE_CHARS,
  RemainingChecks,
  SquareSet,
  attacks,
  between,
  bishopAttacks,
  boardEquals,
  castlingSide,
  charToRole,
  compat_exports as compat,
  debug_exports as debug,
  defaultSetup,
  defined,
  emptySetup,
  fen_exports as fen,
  isDrop,
  isNormal,
  kingAttacks,
  kingCastlesTo,
  knightAttacks,
  makeBoardFen,
  makeCastlingFen,
  makeFen,
  makePiece,
  makePocket,
  makePockets,
  makeRemainingChecks,
  makeSan,
  makeSanAndPlay,
  makeSanVariation,
  makeSquare,
  makeUci,
  opposite,
  parseBoardFen,
  parseCastlingFen,
  parseFen,
  parsePiece,
  parsePockets,
  parseRemainingChecks,
  parseSan,
  parseSquare,
  parseUci,
  pawnAttacks,
  pgn_exports as pgn,
  queenAttacks,
  ray,
  roleToChar,
  rookAttacks,
  san_exports as san,
  setupClone,
  setupEquals,
  squareFile,
  squareRank,
  transform_exports as transform,
  variant_exports as variant
};
