import moment from 'moment';
import { xml2js } from 'xml-js';
import { Map, fromJS } from 'immutable';
import { merge, unset, get, isString, union, isEmpty } from 'lodash';
import { format, parse } from 'url';

import config from '../config/prism.json';
import { AvailableDates } from '../config/types';

const xml2jsOptions = {
  compact: true,
  trim: true,
  ignoreComment: true,
};

export function formatServerUri(
  serverUri: string,
  queryProp: { [key: string]: string | boolean | number },
) {
  // The second arg of 'parse' allows us to have 'query' as an object
  const { query, ...parsedUrl } = parse(serverUri, true);

  // Removing 'search' to be able to format by 'query'
  unset(parsedUrl, 'search');

  return decodeURI(
    format({
      ...parsedUrl,
      query: merge(query, queryProp),
    }),
  );
}

/**
 * Format the raw data to { [layerId]: availableDates }
 * @param rawLayers Layers data return by the server 'GetCapabilities' request
 * @param layerIdPath path to layer's id
 * @param datesPath path to layer's available dates
 * @returns an object shape like { [layerId]: availableDates }
 */
function formatCapabilitiesInfo(
  rawLayers: any,
  layerIdPath: string,
  datesPath: string,
): { [key: string]: number[] } {
  return rawLayers.reduce((acc: any, layer: any) => {
    const layerId = get(layer, layerIdPath);
    const rawDates = get(layer, datesPath, []);

    const dates: (string | { _text: string })[] = isString(rawDates)
      ? rawDates.split(',')
      : rawDates;

    const availableDates = dates
      .filter(date => !isEmpty(date))
      .map(date => moment(get(date, '_text', date)).valueOf());

    const { [layerId]: oldLayerDates } = acc;
    return {
      ...acc,
      [layerId]: union(availableDates, oldLayerDates),
    };
  }, {});
}

/**
 * List capabilities for a WMS layer.
 * @param serverUri
 */
async function getWMSCapabilities(serverUri: string) {
  const requestUri = formatServerUri(serverUri, { request: 'GetCapabilities' });

  try {
    const response = await fetch(requestUri);
    const responseText = await response.text();
    const responseJS = xml2js(responseText, xml2jsOptions);

    const rawLayers = get(responseJS, 'WMS_Capabilities.Capability.Layer');

    const flattenLayers = Array.isArray(rawLayers)
      ? rawLayers.reduce((acc, { Layer }) => acc.concat(Layer), [])
      : get(rawLayers, 'Layer', []);

    const layers = formatCapabilitiesInfo(
      flattenLayers,
      'Name._text',
      'Dimension._text',
    );

    return fromJS(layers) as AvailableDates;
  } catch (error) {
    console.error(
      `Server returned an error for request GET/${requestUri}, error: ${error}`,
    );
    return Map() as AvailableDates;
  }
}

/**
 * List capabilities for a WCS layer.
 * @param serverUri
 */
async function getWCSCoverage(serverUri: string) {
  const requestUri = formatServerUri(serverUri, {
    request: 'DescribeCoverage',
  });

  try {
    const response = await fetch(requestUri);
    const responseText = await response.text();
    const responseJS = xml2js(responseText, xml2jsOptions);

    const rawLayers = get(responseJS, 'CoverageDescription.CoverageOffering');

    const layers = formatCapabilitiesInfo(
      rawLayers,
      'name._text',
      'domainSet.temporalDomain.gml:timePosition',
    );

    return fromJS(layers) as AvailableDates;
  } catch (error) {
    console.error(
      `Server returned an error for request GET/${requestUri}, error: ${error}`,
    );
    return Map() as AvailableDates;
  }
}

/**
 * Given a WMS or WCS serverUri, return a Map of available dates
 * @return a Promise of Map<layerId, availableDate[]>
 */
export async function getLayersAvailableDates() {
  const wmsServerUrls: string[] = get(config, 'serversUrls.wms', []);
  const wcsServerUrls: string[] = get(config, 'serversUrls.wcs', []);

  const [wmsAvailableDates, wcsAvailableDates] = await Promise.all([
    ...wmsServerUrls.map(url => getWMSCapabilities(url)),
    ...wcsServerUrls.map(url => getWCSCoverage(url)),
  ]);

  return wmsAvailableDates.mergeDeep(wcsAvailableDates) as AvailableDates;
}
