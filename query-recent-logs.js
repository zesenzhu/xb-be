require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const dbUrl = process.env.DATABASE_URL || '';
const options = {};
let poolInstance;

if (dbUrl) {
  poolInstance = new Pool({ connectionString: dbUrl });
  const adapter = new PrismaPg(poolInstance);
  options.adapter = adapter;
}

const prisma = new PrismaClient(options);

async function main() {
  const logs = await prisma.scriptLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: 50
  });
  console.log("Recent 50 logs:");
  for (const log of logs.reverse()) {
    console.log(`[${log.timestamp.toISOString()}] [${log.level}] ${log.message}`);
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
    if (poolInstance) {
      await poolInstance.end();
    }
  });
