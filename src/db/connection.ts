import { MongoClient, type Db } from "mongodb";
import { config } from "../config.js";
import { logger } from "../logger.js";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDb(): Promise<Db> {
  if (db) return db;

  client = new MongoClient(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db();
  logger.info({ db: db.databaseName }, "connected to MongoDB");
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("DB not connected — call connectDb() first");
  return db;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logger.info("disconnected from MongoDB");
  }
}
