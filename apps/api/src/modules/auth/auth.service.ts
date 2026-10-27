import { prisma, Role, hashPassword, verifyPassword } from '@auris/database';

export interface UserTokenPayload {
  userId: string;
  email: string;
  organizationId: string;
  role: Role;
}

export class AuthService {
  static hashPassword(password: string): string {
    return hashPassword(password);
  }

  static verifyPassword(password: string, storedHash: string): boolean {
    return verifyPassword(password, storedHash);
  }

  static async registerUser(data: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
  }) {
    const existing = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    if (existing) {
      throw new Error('EMAIL_ALREADY_EXISTS');
    }

    const slug = data.organizationName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `org-${Date.now()}`;

    // Atomic creation of user, organization, membership, wallet, and compliance policy
    return await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: data.organizationName,
          slug: `${slug}-${Math.floor(1000 + Math.random() * 9000)}`,
          defaultLanguage: 'Telugu + English (default)',
        },
      });

      const user = await tx.user.create({
        data: {
          email: data.email.toLowerCase(),
          name: data.name,
          passwordHash: this.hashPassword(data.password),
          status: 'active',
        },
      });

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          role: Role.OWNER,
        },
      });

      // Wallet with 50 credits (₹50.00 default)
      const wallet = await tx.wallet.create({
        data: {
          organizationId: org.id,
          balanceCredits: 50.0000,
          reservedCredits: 0.0000,
          currency: 'INR',
        },
      });

      // Initial compliance policy (configurable, default 90-day retention)
      await tx.compliancePolicy.create({
        data: {
          organizationId: org.id,
          retentionDays: 90,
          smartFollowupsEnabled: false,
          recordingConsentRequired: true,
        },
      });

      return { user, org, membership, wallet };
    });
  }

  static async validateCredentials(email: string, password: string): Promise<UserTokenPayload> {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: {
        memberships: {
          include: { organization: true },
          take: 1,
        },
      },
    });

    if (!user || !user.passwordHash) {
      throw new Error('INVALID_CREDENTIALS');
    }

    const isValid = this.verifyPassword(password, user.passwordHash);
    if (!isValid) {
      throw new Error('INVALID_CREDENTIALS');
    }

    const primaryMembership = user.memberships[0];
    if (!primaryMembership) {
      throw new Error('NO_ORGANIZATION_MEMBERSHIP');
    }

    return {
      userId: user.id,
      email: user.email,
      organizationId: primaryMembership.organizationId,
      role: primaryMembership.role,
    };
  }
}
