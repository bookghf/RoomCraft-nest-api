import { Module } from '@nestjs/common';
import { AdminAuthController } from './auth.controller';
import { AdminStaffController } from './staff.controller';
import { AdminDashboardController } from './dashboard.controller';

// Back office: sign-in, staff accounts, dashboard and audit log.
@Module({ controllers: [AdminAuthController, AdminStaffController, AdminDashboardController] })
export class AdminAuthModule {}
