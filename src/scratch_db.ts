import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('--- DB DIAGNOSTICS START ---');
  const codes = await prisma.registerCode.findMany({
    select: {
      id: true,
      code: true,
      status: true,
      bindDevices: true,
    },
  });
  console.log('Register Codes in Database:');
  console.dir(codes, { depth: null });
  console.log('--- DB DIAGNOSTICS END ---');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
