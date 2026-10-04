import type { Catalog, RoutePriceAvailabilityRow } from './contract.ts';

/** Text inference is a managed service. Its model rates remain server-side. */
export function publicCatalogPricing(catalog:Catalog):Catalog{
 const suffix=':private-text-pricing-v1';
 return {...catalog,version:catalog.version.endsWith(suffix)?catalog.version:catalog.version+suffix,models:catalog.models.map(model=>{
  if(model.capability!=='text')return model;
  const {cost,costField,costPerUnit,costRules,tokenPricing,...visible}=model;
  return {...visible,pricingHidden:true};
 })};
}
export function publicAvailabilityPricing(row:RoutePriceAvailabilityRow):RoutePriceAvailabilityRow{
 if(row.capability!=='text')return row;
 const {pricing,discountPercent,...visible}=row;return visible;
}
