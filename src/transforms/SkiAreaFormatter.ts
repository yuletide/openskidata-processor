import {
  FeatureType,
  SkiAreaFeature,
  SkiAreaProperties,
  SourceType,
} from "openskidata-format";
import { osmID } from "../features/OSMGeoJSONProperties";
import {
  InputOpenStreetMapSkiAreaFeature,
  InputSkiMapOrgSkiAreaFeature,
} from "../features/SkiAreaFeature";
import buildFeature from "./FeatureBuilder";
import { Omit } from "./Omit";
import { getRunConvention } from "./RunFormatter";
import getStatusAndValue from "./Status";

export function formatSkiArea(
  source: SourceType
): (
  feature: InputSkiMapOrgSkiAreaFeature | InputOpenStreetMapSkiAreaFeature
) => SkiAreaFeature | null {
  return (feature) => {
    switch (source) {
      case SourceType.OPENSTREETMAP:
        const osmFeature = feature as InputOpenStreetMapSkiAreaFeature;
        if (
          osmFeature.properties.tags["sport"] !== undefined &&
          osmFeature.properties.tags["sport"] !== "skiing" &&
          osmFeature.properties.tags["sport"] !== "ski"
        ) {
          return null;
        }
        if (
          osmFeature.geometry.type !== "Polygon" &&
          osmFeature.geometry.type !== "MultiPolygon"
        ) {
          return null;
        }

        return buildFeature(
          osmFeature.geometry,
          propertiesForOpenStreetMapSkiArea(osmFeature)
        );
      case SourceType.SKIMAP_ORG:
        return buildFeature(
          feature.geometry,
          propertiesForSkiMapOrgSkiArea(feature as InputSkiMapOrgSkiAreaFeature)
        );
    }
  };
}

function propertiesForOpenStreetMapSkiArea(
  feature: InputOpenStreetMapSkiAreaFeature
): Omit<SkiAreaProperties, "id"> {
  return {
    type: FeatureType.SkiArea,
    name: feature.properties.tags.name || null,
    sources: [
      {
        type: SourceType.OPENSTREETMAP,
        id: osmID(feature.properties),
      },
    ],
    activities: [],
    generated: false,
    // We don't care about the value here, just get the status. The value is always "winter_sports".
    status: getStatusAndValue(
      "landuse",
      feature.properties.tags as { [key: string]: string }
    ).status,
    website: feature.properties.tags.website || null,
    runConvention: getRunConvention(feature),
    location: null,
  };
}

function propertiesForSkiMapOrgSkiArea(
  feature: InputSkiMapOrgSkiAreaFeature
): Omit<SkiAreaProperties, "id"> {
  const activities = feature.properties.activities;
  return {
    type: FeatureType.SkiArea,
    name: feature.properties.name || null,
    sources: [
      {
        type: SourceType.SKIMAP_ORG,
        id: feature.properties.id,
      },
    ],
    activities: activities,
    generated: false,
    status: feature.properties.status,
    runConvention: getRunConvention(feature),
    website: feature.properties.official_website,
    location: null,
  };
}
