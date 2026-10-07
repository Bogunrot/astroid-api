import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationPlan, UserRole, UserStatus } from '@prisma/client';
import { sanitizeTextField } from '../../common/validators/text-field.sanitizer';

export const updateOrganizationSchema = z
  .object({
    name: z.string().min(2).max(120).transform(sanitizeTextField).optional(),
    description: z.string().max(500).transform(sanitizeTextField).optional(),
    logo: z.string().url().optional(),
    plan: z.nativeEnum(OrganizationPlan).optional(),
  })
  .strict();

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const inviteMemberSchema = z
  .object({
    name: z.string().min(1).transform(sanitizeTextField),
    email: z.string().email(),
    role: z.nativeEnum(UserRole),
  })
  .strict();

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: z.nativeEnum(UserRole).optional(),
    status: z.nativeEnum(UserStatus).optional(),
  })
  .strict();

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Acme Corp' })
  name?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  logo?: string;

  @ApiPropertyOptional({ enum: OrganizationPlan })
  plan?: OrganizationPlan;
}

export class InviteMemberDto {
  @ApiProperty({ example: 'John Doe' })
  name!: string;

  @ApiProperty({ example: 'john@example.com' })
  email!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.DEVELOPER })
  role!: UserRole;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: UserRole })
  role?: UserRole;

  @ApiPropertyOptional({ enum: UserStatus })
  status?: UserStatus;
}
