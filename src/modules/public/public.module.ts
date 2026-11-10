import { Module } from '@nestjs/common';

// Public and resident routes: catalog, plans, room types, designs, drafts, /me, shares.
// Add controllers to this list.
@Module({ controllers: [] })
export class PublicModule {}
