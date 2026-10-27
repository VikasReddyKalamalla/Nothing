import { PrismaClient, Role, AgentRoleType, VoiceTier } from '@prisma/client';
import { hashPassword } from './crypto.js';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ CRITICAL ERROR: Database seeding is permanently forbidden in PRODUCTION environment.');
    console.error('Dev accounts cannot be seeded to production instances.');
    process.exit(1);
  }

  console.log('🌱 Starting Auris Database Seeding (Environment: DEVELOPMENT)...');

  // 1. Create or upsert Organization
  const org = await prisma.organization.upsert({
    where: { slug: 'clinicxs' },
    update: {},
    create: {
      name: 'clinicxs',
      slug: 'clinicxs',
      defaultLanguage: 'Telugu + English (default)',
      smartFollowups: false,
    },
  });
  console.log(`✅ Organization created: ${org.name} (${org.id})`);

  // 2. Create or upsert User (Development Only Account)
  const devPassword = process.env.SEED_ADMIN_PASSWORD || 'password123';
  const passwordHash = hashPassword(devPassword);
  const user = await prisma.user.upsert({
    where: { email: 'vikasreddyk0@gmail.com' },
    update: {
      passwordHash, // Refresh to secure PBKDF2 format
    },
    create: {
      email: 'vikasreddyk0@gmail.com',
      name: 'Vikas Reddy (Dev Admin)',
      passwordHash,
      status: 'active',
    },
  });
  console.log(`✅ [DEV ONLY] Seeded user configured: ${user.email} (${user.id})`);

  // 3. Ensure Membership
  await prisma.membership.upsert({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId: org.id,
      },
    },
    update: {},
    create: {
      userId: user.id,
      organizationId: org.id,
      role: Role.OWNER,
    },
  });
  console.log(`✅ Membership linked: Role OWNER`);

  // 4. Ensure Wallet with ₹50.00 credits (matching screenshot)
  const wallet = await prisma.wallet.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      balanceCredits: 50.0000,
      reservedCredits: 0.0000,
      currency: 'INR',
      lowBalanceThreshold: 50.0000,
    },
  });
  console.log(`✅ Wallet initialized: ₹${wallet.balanceCredits} credits`);

  // 5. Initial Compliance Policy (90-day retention default, configurable)
  await prisma.compliancePolicy.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      retentionDays: 90,
      smartFollowupsEnabled: false,
      recordingConsentRequired: true,
    },
  });
  console.log(`✅ Compliance Policy initialized: 90 days retention`);

  // 6. Policy Acceptance record (matches screenshot "Version 2026-07-25")
  const existingAcceptance = await prisma.policyAcceptance.findFirst({
    where: {
      organizationId: org.id,
      policyName: 'Terms of Service & Privacy Policy',
    },
  });
  if (!existingAcceptance) {
    await prisma.policyAcceptance.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        policyName: 'Terms of Service & Privacy Policy',
        version: '2026-07-25',
      },
    });
  }
  console.log(`✅ Policy Acceptance logged: Version 2026-07-25`);

  // 7. Seed Initial Agent: "Sneha" (Real estate qualifier)
  const existingAgent = await prisma.agent.findFirst({
    where: { organizationId: org.id, name: 'Sneha - Lead Qualifier' },
  });
  if (!existingAgent) {
    const agent = await prisma.agent.create({
      data: {
        organizationId: org.id,
        name: 'Sneha - Lead Qualifier',
        roleType: AgentRoleType.INSTANT_LEAD,
        voiceTier: VoiceTier.STANDARD,
        voiceId: 'sarvam-bulbul-sneha',
        primaryLanguage: 'Telugu + English',
        englishEnhance: true,
        promptTemplate: `You are Sneha, a polite real-estate telecalling agent for Sai Constructions. Greet the caller in Telugu/English, ask if they enquired about 2 or 3BHK flats, confirm their budget, and invite them for a site visit on Saturday.`,
      },
    });
    // Create initial immutable snapshot version 1
    await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        snapshotJson: {
          name: agent.name,
          roleType: agent.roleType,
          voiceTier: agent.voiceTier,
          voiceId: agent.voiceId,
          primaryLanguage: agent.primaryLanguage,
          promptTemplate: agent.promptTemplate,
        },
        publishedBy: user.id,
      },
    });
    console.log(`✅ Seed Agent created: ${agent.name} (v1 snapshot saved)`);
  }

  console.log('✨ Auris Database Seeding Completed Successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
