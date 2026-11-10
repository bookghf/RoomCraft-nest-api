import { Module } from '@nestjs/common';
import { AdminPlansController } from './admin-plans.controller';
import { AdminSupportController } from './admin-support.controller';

// Back office: plans, room types, designs, users and shares.
@Module({ controllers: [AdminPlansController, AdminSupportController] })
export class AdminSupportModule {}
