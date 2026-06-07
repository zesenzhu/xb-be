import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const perms = await prisma.permission.findMany({
      orderBy: { code: 'asc' }
    });
    console.log('--- ALL PERMISSIONS IN DB ---');
    console.log(JSON.stringify(perms, null, 2));

    const roles = await prisma.role.findMany({
      include: {
        permissions: {
          select: { code: true }
        }
      }
    });
    console.log('--- ALL ROLES IN DB ---');
    console.log(JSON.stringify(roles, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
