import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PublicModule } from './modules/public/public.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AdminCatalogModule } from './modules/admin-catalog/admin-catalog.module';
import { AdminSupportModule } from './modules/admin-support/admin-support.module';

@Module({
  imports: [PublicModule, AdminAuthModule, AdminCatalogModule, AdminSupportModule],
  controllers: [HealthController],
})
export class AppModule {}
