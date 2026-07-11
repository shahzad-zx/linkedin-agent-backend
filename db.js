// db.js — tiny file-based database (no install headaches, no native compiling).
// Data lives in server/db.json. Fine for a personal project / small user base.
// Swap for Postgres/MySQL later if this grows — the interface below is small on purpose.

import { JSONFilePreset } from "lowdb/node";

const defaultData = { users: [] };
const db = await JSONFilePreset("db.json", defaultData);

export async function findUserByEmail(email) {
  await db.read();
  return db.data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

export async function findUserById(id) {
  await db.read();
  return db.data.users.find((u) => u.id === id);
}

export async function createUser({ id, name, email, passwordHash }) {
  await db.read();
  const user = { id, name, email, passwordHash, createdAt: new Date().toISOString() };
  db.data.users.push(user);
  await db.write();
  return user;
}

export default db;