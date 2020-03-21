import {
  FeatureType,
  SkiAreaFeature,
  SkiAreaProperties,
  SourceType
} from "openskidata-format";
import {
  InputOpenStreetMapSkiAreaFeature,
  InputSkiMapOrgSkiAreaFeature
} from "../features/SkiAreaFeature";
import buildFeature from "./FeatureBuilder";
import { Omit } from "./Omit";
import { getRunConvention } from "./RunFormatter";
import getStatusAndValue from "./Status";

export function formatSkiArea(
  source: SourceType
): (
  feature: InputSkiMapOrgSkiAreaFeature | InputOpenStreetMapSkiAreaFeature
) => SkiAreaFeature {
  return feature => {
    switch (source) {
      case SourceType.OPENSTREETMAP:
        return buildFeature(
          feature.geometry,
          propertiesForOpenStreetMapSkiArea(
            feature as InputOpenStreetMapSkiAreaFeature
          )
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
    name: feature.properties.name || null,
    sources: [
      {
        type: SourceType.OPENSTREETMAP,
        id: feature.properties.id
      }
    ],
    activities: [],
    generated: false,
    // We don't care about the value here, just get the status. The value is always "winter_sports".
    status: getStatusAndValue(
      "landuse",
      feature.properties as { [key: string]: string }
    ).status,
    website: feature.properties.website || null,
    runConvention: getRunConvention(feature)
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
        id: feature.properties.id
      }
    ],
    activities: activities,
    generated: false,
    status: feature.properties.status,
    runConvention: getRunConvention(feature),
    website: feature.properties.official_website
  };
}
