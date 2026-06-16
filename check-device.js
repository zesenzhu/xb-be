require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const codes = await prisma.registerCode.findMany();
  console.log("All Register Codes in DB:");
  for (const c of codes) {
    console.log(`Code: ${c.code}, ExpireTime: ${c.expireTime}, bindDevices: ${c.bindDevices}`);
  }
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
