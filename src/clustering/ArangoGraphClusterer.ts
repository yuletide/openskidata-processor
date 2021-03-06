import centroid from "@turf/centroid";
import * as turf from "@turf/helpers";
import { aql, Database } from "arangojs";
import { AqlQuery } from "arangojs/lib/cjs/aql-query";
import { AssertionError } from "assert";
import * as GeoJSON from "geojson";
import { Activity, FeatureType, SourceType, Status } from "openskidata-format";
import uuid from "uuid/v4";
import { skiAreaStatistics } from "../statistics/SkiAreaStatistics";
import Geocoder from "../transforms/Geocoder";
import { bufferGeometry } from "../transforms/GeoTransforms";
import { getRunConvention } from "../transforms/RunFormatter";
import {
  DraftSkiArea,
  LiftObject,
  MapObject,
  MapObjectType,
  RunObject,
  SkiAreaObject,
} from "./MapObject";
import mergeSkiAreaObjects from "./MergeSkiAreaObjects";
import { emptySkiAreasCursor, SkiAreasCursor } from "./SkiAreasCursor";

interface VisitContext {
  id: string;
  activities: Activity[];
  excludeObjectsAlreadyInSkiAreaPolygon?: boolean;
  searchPolygon?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  alreadyVisited: string[];
}

const maxDistanceInKilometers = 0.5;

export const allSkiAreaActivities = new Set([
  Activity.Downhill,
  Activity.Nordic,
]);

/**
 * - Associate runs & lifts with ski areas.
 * - Combine ski areas from different sources (Skimap.org and OpenStreetMap)
 * - Generate statistics for each ski area
 *
 * Because the relationships between objects are only implied based on their relative positions,
 * this is not perfect. There are a number of stages to handle some well known edge cases, like adjacent ski areas.
 */
export default async function clusterArangoGraph(
  database: Database,
  geocoder: Geocoder | null
): Promise<void> {
  const objectsCollection = database.collection("objects");

  await removeAmbiguousDuplicateSkiAreas();

  // For all OpenStreetMap ski areas (polygons), associate runs & lifts within that polygon.
  // Ski areas without any objects or with a significant number of objects assigned to a site=piste relation are removed.
  await assignObjectsToSkiAreas({
    skiArea: {
      onlySource: SourceType.OPENSTREETMAP,
      removeIfNoObjectsFound: true,
      removeIfSubstantialNumberOfObjectsInSkiAreaSite: true,
    },
    objects: { onlyInPolygon: true },
  });

  // For all OpenStreetMap ski areas, in a second pass, associate nearby runs & lifts that are not already assigned to a ski area polygon.
  await assignObjectsToSkiAreas({
    skiArea: { onlySource: SourceType.OPENSTREETMAP },
    objects: { onlyIfNotAlreadyAssignedToPolygon: true },
  });

  // For all Skimap.org ski areas, associate nearby runs & lifts that are not already assigned to a ski area area polygon.
  // Merge ski areas from different sources: For all Skimap.org ski areas,
  // if an OpenStreetMap ski area is nearby or its geometry encloses the Skimap.org ski area, merge them.
  await assignObjectsToSkiAreas({
    skiArea: {
      onlySource: SourceType.SKIMAP_ORG,
      mergeWithOtherSourceIfNearby: true,
    },
    objects: { onlyIfNotAlreadyAssignedToPolygon: true },
  });

  // For each remaining unclaimed run, generate a ski area for it, associating nearby unclaimed runs & lifts.
  await generateSkiAreasForUnassignedObjects();

  await augmentSkiAreasBasedOnAssignedLiftsAndRuns(geocoder);

  /**
   * Remove OpenStreetMap ski areas that contain multiple Skimap.org ski areas in their geometry.
   * This step removes relations that span across a group of separate ski resorts that have a shared ticketing system,
   * for example: https://www.openstreetmap.org/relation/10728343
   */
  async function removeAmbiguousDuplicateSkiAreas(): Promise<void> {
    const cursor = await getSkiAreas({
      onlyPolygons: true,
      onlySource: SourceType.OPENSTREETMAP,
    });

    let skiAreas: SkiAreaObject[];
    while ((skiAreas = (await cursor.nextBatch()) as SkiAreaObject[])) {
      await Promise.all(
        skiAreas.map(async (skiArea) => {
          if (
            skiArea.geometry.type !== "Polygon" &&
            skiArea.geometry.type !== "MultiPolygon"
          ) {
            throw new AssertionError({
              message:
                "getSkiAreas query should have only returned ski areas with a Polygon geometry.",
            });
          }
          const otherSkiAreasCursor = await getSkiAreas({
            onlySource: SourceType.SKIMAP_ORG,
            onlyInPolygon: skiArea.geometry,
          });

          const otherSkiAreas = await otherSkiAreasCursor.all();
          if (otherSkiAreas.length > 1) {
            console.log(
              "Removing OpenStreetMap ski area as it contains multiple Skimap.org ski areas and can't be merged correctly."
            );
            console.log(JSON.stringify(skiArea));

            await objectsCollection.remove({ _key: skiArea._key });
          }
        })
      );
    }
  }

  async function assignObjectsToSkiAreas(options: {
    skiArea: {
      onlySource: SourceType;
      mergeWithOtherSourceIfNearby?: boolean;
      removeIfNoObjectsFound?: boolean;
      removeIfSubstantialNumberOfObjectsInSkiAreaSite?: boolean;
    };
    objects: {
      onlyIfNotAlreadyAssignedToPolygon?: boolean;
      onlyInPolygon?: boolean;
    };
  }): Promise<void> {
    const skiAreasCursor = await getSkiAreas({
      onlyPolygons: options.objects.onlyInPolygon || false,
      onlySource: options.skiArea.onlySource,
    });

    let skiAreas: SkiAreaObject[];
    while ((skiAreas = (await skiAreasCursor.nextBatch()) as SkiAreaObject[])) {
      await Promise.all(
        skiAreas.map(async (skiArea) => {
          const id = skiArea.properties.id;
          if (!id) {
            throw "No ID for ski area starting object";
          }

          if (options.skiArea.mergeWithOtherSourceIfNearby) {
            const skiAreasToMerge = await getSkiAreasToMerge(skiArea);
            if (skiAreasToMerge.length > 0) {
              await mergeSkiAreas([skiArea, ...skiAreasToMerge]);
              return;
            }
          }

          let searchPolygon:
            | GeoJSON.Polygon
            | GeoJSON.MultiPolygon
            | null = null;
          if (options.objects.onlyInPolygon) {
            if (
              skiArea.geometry.type === "Polygon" ||
              skiArea.geometry.type === "MultiPolygon"
            ) {
              searchPolygon = skiArea.geometry;
            } else {
              throw new AssertionError({
                message: "Ski area geometry must be a polygon.",
              });
            }
          }

          const hasKnownSkiAreaActivities = skiArea.activities.length > 0;
          const activitiesForClustering = hasKnownSkiAreaActivities
            ? skiArea.activities
            : [...allSkiAreaActivities];
          skiArea.activities = activitiesForClustering;

          const memberObjects = await visitObject(
            {
              id: id,
              activities: activitiesForClustering,
              searchPolygon: searchPolygon,
              alreadyVisited: [skiArea._key],
              excludeObjectsAlreadyInSkiAreaPolygon:
                options.objects.onlyIfNotAlreadyAssignedToPolygon || false,
            },
            skiArea
          );
          const removeDueToNoObjects =
            options.skiArea.removeIfNoObjectsFound &&
            !memberObjects.some(
              (object) => object.type !== MapObjectType.SkiArea
            );
          if (removeDueToNoObjects) {
            console.log(
              `Removing ski area (${JSON.stringify(
                skiArea.properties.sources
              )}) as no objects were found.`
            );
            await objectsCollection.remove({ _key: skiArea._key });
            return;
          }

          const liftsAndRuns = memberObjects.filter(
            (object): object is LiftObject | RunObject =>
              object.type === MapObjectType.Lift ||
              object.type === MapObjectType.Run
          );
          const liftsAndRunsInSiteRelation = liftsAndRuns.filter(
            (object) => object.isInSkiAreaSite
          );
          const removeDueToSignificantObjectsInSiteRelation =
            options.skiArea.removeIfSubstantialNumberOfObjectsInSkiAreaSite &&
            liftsAndRunsInSiteRelation.length / liftsAndRuns.length > 0.5;
          if (removeDueToSignificantObjectsInSiteRelation) {
            console.log(
              `Removing ski area (${JSON.stringify(
                skiArea.properties.sources
              )}) as a substantial number of objects were in a site=piste relation (${
                liftsAndRunsInSiteRelation.length
              } / ${liftsAndRuns.length}).`
            );
            await objectsCollection.remove({ _key: skiArea._key });
            return;
          }

          await markSkiArea(
            id,
            options.objects.onlyInPolygon || false,
            memberObjects
          );

          // Determine ski area activities based on the clustered objects.
          if (!hasKnownSkiAreaActivities) {
            const activities = memberObjects
              .filter((object) => object.type !== MapObjectType.SkiArea)
              .reduce((accumulatedActivities, object) => {
                object.activities.forEach((activity) => {
                  if (allSkiAreaActivities.has(activity)) {
                    accumulatedActivities.add(activity);
                  }
                });
                return accumulatedActivities;
              }, new Set(skiArea.properties.activities));

            await objectsCollection.update(
              { _key: skiArea._key },
              {
                activities: [...activities],
                properties: {
                  activities: [...activities],
                },
              }
            );
          }
        })
      );
    }
  }

  async function generateSkiAreasForUnassignedObjects(): Promise<void> {
    let unassignedRun: MapObject;
    while ((unassignedRun = await nextUnassignedRun())) {
      try {
        await generateSkiAreaForRun(unassignedRun);
      } catch (exception) {
        console.log("Processing unassigned run failed.", exception);
      }
    }
  }

  async function generateSkiAreaForRun(unassignedRun: RunObject) {
    const newSkiAreaID = uuid();
    let activities = unassignedRun.activities.filter((activity) =>
      allSkiAreaActivities.has(activity)
    );
    let memberObjects = await visitObject(
      {
        id: newSkiAreaID,
        activities: activities,
        alreadyVisited: [unassignedRun._key],
      },
      unassignedRun
    );

    // Downhill ski areas must contain at least one lift.
    if (
      activities.includes(Activity.Downhill) &&
      !memberObjects.some((object) => object.type == MapObjectType.Lift)
    ) {
      activities = activities.filter(
        (activity) => activity !== Activity.Downhill
      );
      memberObjects = memberObjects.filter((object) => {
        const hasAnotherActivity = object.activities.some(
          (activity) =>
            activity !== Activity.Downhill && allSkiAreaActivities.has(activity)
        );
        return hasAnotherActivity;
      });
    }

    if (activities.length === 0 || memberObjects.length === 0) {
      await objectsCollection.update(
        { _key: unassignedRun._key },
        { isBasisForNewSkiArea: false }
      );
      return;
    }

    await createGeneratedSkiArea(newSkiAreaID, activities, memberObjects);
  }

  async function visitPolygon(
    context: VisitContext,
    geometry: GeoJSON.Polygon
  ): Promise<MapObject[]> {
    const isInSkiAreaPolygon = context.searchPolygon ? true : false;
    const objects = await findNearbyObjects(
      geometry,
      isInSkiAreaPolygon ? "contains" : "intersects",
      context
    );

    // Skip further traversal if we are searching a fixed polygon.
    if (isInSkiAreaPolygon) {
      return objects;
    } else {
      let foundObjects: MapObject[] = [];
      for (let i = 0; i < objects.length; i++) {
        foundObjects = foundObjects.concat(
          await visitObject(context, objects[i])
        );
      }
      return foundObjects;
    }
  }

  async function visitObject(
    context: VisitContext,
    object: MapObject
  ): Promise<MapObject[]> {
    let searchArea =
      context.searchPolygon ||
      bufferGeometry(object.geometry, maxDistanceInKilometers);
    let foundObjects: MapObject[] = [object];
    if (searchArea === null) {
      return foundObjects;
    }
    const objectContext = {
      ...context,
      activities: context.activities.filter((activity) =>
        object.activities.includes(activity)
      ),
    };
    switch (searchArea.type) {
      case "Polygon":
        return foundObjects.concat(
          await visitPolygon(objectContext, searchArea)
        );
      case "MultiPolygon":
        for (let i = 0; i < searchArea.coordinates.length; i++) {
          foundObjects = foundObjects.concat(
            await visitPolygon(
              objectContext,
              turf.polygon(searchArea.coordinates[i]).geometry
            )
          );
        }
        return foundObjects;
      default:
        throw "Unexpected visit area geometry type " + searchArea;
    }
  }

  async function getSkiAreasToMerge(
    skiArea: SkiAreaObject
  ): Promise<SkiAreaObject[]> {
    const maxMergeDistanceInKilometers = 0.25;
    const buffer = bufferGeometry(
      skiArea.geometry,
      maxMergeDistanceInKilometers
    );
    if (!buffer) {
      return [];
    }

    const nearbyObjects = await findNearbyObjects(buffer, "intersects", {
      id: skiArea.id,
      activities: skiArea.activities,
      alreadyVisited: [],
    });

    const otherSkiAreaIDs = new Set(
      nearbyObjects.flatMap((object) => object.skiAreas)
    );
    const otherSkiAreasCursor = await getSkiAreasByID(
      Array.from(otherSkiAreaIDs)
    );
    const otherSkiAreas: SkiAreaObject[] = await otherSkiAreasCursor.all();

    return otherSkiAreas.filter(
      (otherSkiArea) => otherSkiArea.source != skiArea.source
    );
  }

  async function mergeSkiAreas(skiAreas: SkiAreaObject[]): Promise<void> {
    console.log(
      "Merging ski areas: " +
        skiAreas.map((object) => JSON.stringify(object.properties)).join(", ")
    );

    const ids = new Set(skiAreas.map((skiArea) => skiArea._key));
    const skiArea = mergeSkiAreaObjects(skiAreas);
    if (skiArea === null) {
      return;
    }

    // Update merged ski area
    await objectsCollection.update(skiArea._id, skiArea);

    ids.delete(skiArea._key);

    // Update references to merged ski areas
    await database.query(aql`
    FOR object in ${objectsCollection}
    FILTER ${[...ids]} ANY IN object.skiAreas
    UPDATE {
      _key: object._key,
      skiAreas: APPEND(
        REMOVE_VALUES(object.skiAreas, ${[...ids]}),
        [${skiArea._key}],
        true)
    } IN ${objectsCollection}
    OPTIONS { exclusive: true }
    `);

    // Remove other ski areas
    await objectsCollection.removeByKeys([...ids], {});
  }

  async function findNearbyObjects(
    area: GeoJSON.Polygon | GeoJSON.MultiPolygon,
    match: "intersects" | "contains",
    context: VisitContext
  ): Promise<MapObject[]> {
    const query = aql`
            FOR object in ${objectsCollection}
            FILTER ${
              match === "intersects" ? aql`GEO_INTERSECTS` : aql`GEO_CONTAINS`
            }(${arangoGeometry(area)}, object.geometry)
            FILTER ${context.id} NOT IN object.skiAreas
            FILTER object._key NOT IN ${context.alreadyVisited}
            ${
              context.excludeObjectsAlreadyInSkiAreaPolygon
                ? aql`FILTER object.isInSkiAreaPolygon != true`
                : aql``
            }
            FILTER object.activities ANY IN ${context.activities}
            RETURN object
        `;

    try {
      const cursor = await database.query(query, { ttl: 120 });
      const allFound: MapObject[] = await cursor.all();
      allFound.forEach((object) => context.alreadyVisited.push(object._key));
      return allFound;
    } catch (error) {
      if (isInvalidGeometryError(error)) {
        // ArangoDB can fail with polygon not valid in rare cases.
        // Seems to happen when people abuse landuse=winter_sports and add all members of a ski area to a multipolygon relation.
        // For example https://www.openstreetmap.org/relation/6250272
        // In that case, we just log it and move on.
        console.log("Failed finding nearby objects (invalid polygon)");
        console.log(error);
        console.log("Area: " + JSON.stringify(area));
        return [];
      }

      throw error;
    }
  }

  async function markSkiArea(
    id: string,
    isInSkiAreaPolygon: boolean,
    objects: MapObject[]
  ): Promise<void> {
    const query = aql`
            FOR object in ${objectsCollection}
            FILTER object._key IN ${objects.map((object) => object._key)}
            UPDATE {
              _key: object._key,
              isBasisForNewSkiArea: false,
              isInSkiAreaPolygon: object.isInSkiAreaPolygon || ${isInSkiAreaPolygon},
              skiAreas: APPEND(
                object.skiAreas,
                ${[id]},
                true
              )
            } IN ${objectsCollection}
            OPTIONS { exclusive: true }
        `;

    await database.query(query);
  }

  async function getSkiAreasByID(ids: string[]): Promise<SkiAreasCursor> {
    return await database.query(
      aql`
            FOR object IN ${objectsCollection}
            FILTER object.id IN ${ids}
            RETURN object`
    );
  }

  async function getSkiAreas(options: {
    onlySource?: SourceType | null;
    onlyPolygons?: boolean;
    onlyInPolygon?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  }): Promise<SkiAreasCursor> {
    const batchSize = 50;
    try {
      return await database.query(
        aql`
            FOR object IN ${objectsCollection}
            ${
              options.onlyInPolygon
                ? aql`FILTER GEO_INTERSECTS(${arangoGeometry(
                    options.onlyInPolygon
                  )}, object.geometry)`
                : aql``
            }
            FILTER object.type == ${MapObjectType.SkiArea}
            ${
              options.onlySource
                ? aql`FILTER object.source == ${options.onlySource}`
                : aql``
            }
            ${
              options.onlyPolygons
                ? aql`FILTER object.isPolygon == true`
                : aql``
            }
            RETURN object`,
        { batchSize: batchSize, ttl: 3600 }
      );
    } catch (error) {
      if (isInvalidGeometryError(error)) {
        console.log("Failed getting ski areas (invalid geometry)");
        console.log(error);
        console.log("Options: " + JSON.stringify(options));
        return emptySkiAreasCursor();
      }
      throw error;
    }
  }

  // Find a run that isn't part of a ski area.
  async function nextUnassignedRun(): Promise<RunObject> {
    const array = await database.query(aql`
            FOR object IN ${objectsCollection}
            FILTER object.isBasisForNewSkiArea == true
            LIMIT ${1}
            RETURN object`);

    const run: RunObject = await array.next();
    if (run && run.activities.length == 0) {
      throw "No activities for run";
    }
    return run;
  }

  async function createGeneratedSkiArea(
    id: string,
    activities: Activity[],
    memberObjects: MapObject[]
  ): Promise<void> {
    const features = memberObjects.map<GeoJSON.Feature>((object) => {
      return { type: "Feature", geometry: object.geometry, properties: {} };
    });
    const objects = turf.featureCollection(features);
    const geometry = centroid(objects as turf.FeatureCollection<any, any>)
      .geometry;
    if (!geometry) {
      throw "No centroid point could be found.";
    }

    const draftSkiArea: DraftSkiArea = {
      _key: id,
      id: id,
      type: MapObjectType.SkiArea,
      skiAreas: [id],
      activities: activities,
      geometry: geometry,
      isPolygon: true,
      source: SourceType.OPENSTREETMAP,
      properties: {
        type: FeatureType.SkiArea,
        id: id,
        name: null,
        generated: true,
        activities: activities,
        status: Status.Operating,
        sources: [],
        runConvention: getRunConvention(geometry),
        website: null,
        location: null,
      },
    };

    try {
      await objectsCollection.save(draftSkiArea);
    } catch (exception) {
      console.log("Failed saving ski area", exception);
      throw exception;
    }

    await markSkiArea(id, false, memberObjects);
  }

  async function getObjects(skiAreaID: string): Promise<MapObject[]> {
    const query = aql`
            FOR object in ${objectsCollection}
            FILTER ${skiAreaID} IN object.skiAreas
            FILTER object.type != ${MapObjectType.SkiArea}
            RETURN object
        `;

    const cursor = await database.query(query);
    return await cursor.all();
  }

  // TODO: Also augment ski area geometry based on runs & lifts
  async function augmentSkiAreasBasedOnAssignedLiftsAndRuns(
    geocoder: Geocoder | null
  ): Promise<void> {
    const skiAreasCursor = await getSkiAreas({});
    let skiAreas: SkiAreaObject[];
    while ((skiAreas = (await skiAreasCursor.nextBatch()) as SkiAreaObject[])) {
      await Promise.all(
        skiAreas.map(async (skiArea) => {
          const mapObjects = await getObjects(skiArea.id);
          await augmentSkiAreaBasedOnAssignedLiftsAndRuns(
            skiArea,
            mapObjects,
            geocoder
          );
        })
      );
    }
  }

  async function augmentSkiAreaBasedOnAssignedLiftsAndRuns(
    skiArea: SkiAreaObject,
    memberObjects: MapObject[],
    geocoder: Geocoder | null
  ): Promise<void> {
    const noSkimapOrgSource = !skiArea.properties.sources.some(
      (source) => source.type == SourceType.SKIMAP_ORG
    );
    if (memberObjects.length === 0 && noSkimapOrgSource) {
      // Remove OpenStreetMap ski areas with no associated runs or lifts.
      // These are likely not actually ski areas,
      // as the OpenStreetMap tagging semantics (landuse=winter_sports) are not ski area specific.
      console.log(
        "Removing OpenStreetMap ski area without associated runs/lifts."
      );

      await objectsCollection.remove({ _key: skiArea._key });
      return;
    }

    skiArea.properties.statistics = skiAreaStatistics(memberObjects);

    const newGeometry =
      memberObjects.length > 0
        ? centroid({
            type: "GeometryCollection",
            geometries: memberObjects.map((object) => object.geometry),
          }).geometry
        : skiArea.geometry;

    skiArea.geometry = newGeometry;
    skiArea.isPolygon = false;
    skiArea.properties.runConvention = getRunConvention(newGeometry);

    if (geocoder) {
      const coordinates = centroid(newGeometry).geometry.coordinates;
      try {
        skiArea.properties.location = await geocoder.geocode(coordinates);
      } catch (error) {
        console.log(`Failed geocoding ${JSON.stringify(coordinates)}`);
        console.log(error);
      }
    }

    await await objectsCollection.update(skiArea.id, skiArea);
  }

  function arangoGeometry(
    object: GeoJSON.Polygon | GeoJSON.MultiPolygon
  ): AqlQuery {
    switch (object.type) {
      case "Polygon":
        return aql`GEO_POLYGON(${object.coordinates})`;
      case "MultiPolygon":
        return aql`GEO_MULTIPOLYGON(${object.coordinates})`;
    }
  }

  function isInvalidGeometryError(error: any): boolean {
    return (
      (error.response.body.errorMessage as string).includes(
        "Polygon is not valid"
      ) ||
      (error.response.body.errorMessage as string).includes(
        "Invalid loop in polygon"
      ) ||
      (error.response.body.errorMessage as string).includes("Loop not closed")
    );
  }
}
