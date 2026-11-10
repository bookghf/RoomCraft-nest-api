import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { PlansController } from './plans.controller';
import { DesignsController } from './designs.controller';
import { DraftsController } from './drafts.controller';
import { MeController } from './me.controller';
import { SharesController } from './shares.controller';

// Public and resident routes: catalog, plans, room types, designs, drafts, /me, shares.
@Module({
  controllers: [CatalogController, PlansController, DesignsController, DraftsController, MeController, SharesController],
})
export class PublicModule {}
