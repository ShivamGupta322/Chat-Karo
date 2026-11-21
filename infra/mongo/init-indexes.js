// Creates chatErl's MongoDB collections and indexes.
// Runs automatically on first start of an empty mongo volume (docker-entrypoint-initdb.d),
// and is safe to re-run by hand:  docker compose exec mongo mongosh chaterl /docker-entrypoint-initdb.d/init-indexes.js
// Every index the code relies on MUST be declared here (see CLAUDE.md). GeoJSON order is [lng, lat].
// Changing an existing index's options (e.g. a TTL) with createIndex throws IndexOptionsConflict:
// use db.runCommand({ collMod: "<coll>", index: { name: "<name>", expireAfterSeconds: N } }) instead.

const dbName = process.env.MONGO_INITDB_DATABASE || "chaterl";
const d = db.getSiblingDB(dbName);

function ensureCollection(name) {
  if (!d.getCollectionNames().includes(name)) d.createCollection(name);
}

// rooms — one per geohash cell that has been active. _id = "g<precision>_<geohash>"
ensureCollection("rooms");
d.rooms.createIndex({ center: "2dsphere" }, { name: "center_2dsphere" });
d.rooms.createIndex(
  { lastActiveAt: 1 },
  { name: "lastActiveAt_ttl", expireAfterSeconds: 7 * 24 * 3600 } // idle rooms removed after 7 days
);

// places — seeded points of interest
ensureCollection("places");
d.places.createIndex({ location: "2dsphere" }, { name: "location_2dsphere" });

// profiles — _id = the random XMPP localpart u<32 hex> (never derived from the nickname)
ensureCollection("profiles");
// Case-insensitive uniqueness: "Alice" and "alice" are the same nickname. Queries that should use this
// index must pass the same collation.
d.profiles.createIndex(
  { nickname: 1 },
  { name: "nickname_unique_ci", unique: true, collation: { locale: "en", strength: 2 } }
);
// A pending reservation (state "pending") carries expiresAt = createdAt + 600 s; the TTL monitor deletes
// orphaned ones so their nickname becomes free again (within ~11 min, the monitor runs every 60 s).
// Activation unsets expiresAt, so active profiles never expire. Must be a BSON Date.
d.profiles.createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });

// reports — moderation reports, kept 30 days
ensureCollection("reports");
d.reports.createIndex(
  { createdAt: 1 },
  { name: "createdAt_ttl", expireAfterSeconds: 30 * 24 * 3600 }
);
d.reports.createIndex({ roomId: 1, createdAt: -1 }, { name: "roomId_createdAt" });

print(`chatErl: indexes ensured on database "${dbName}"`);
