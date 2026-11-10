import { Module } from '@nestjs/common';
import { CatalogItemsController } from './catalog-items.controller';
import { CatalogPublishController } from './catalog-publish.controller';
import { CategoriesController } from './categories.controller';

// Back office: catalog items, publishing, versions and categories.
@Module({ controllers: [CatalogItemsController, CatalogPublishController, CategoriesController] })
export class AdminCatalogModule {}
