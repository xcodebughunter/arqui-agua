import { AnyLayer } from 'maplibre-gl';
import colors from '@/styles/_colors.module.scss';
const { green, orange, yellow, black, white } = colors;

export const layers: AnyLayer[] = [
	{
		id: '__directus_polygons_outline',
		type: 'line',
		source: '__directus',
		filter: ['all', ['!has', 'point_count'], ['==', '$type', 'Polygon']],
		paint: {
			'line-color': [
				'case',
				['boolean', ['feature-state', 'selected'], false],
				orange,
				['boolean', ['feature-state', 'hovered'], false],
				orange,
				green,
			],
			'line-width': 2,
		},
		layout: {
			'line-join': 'round',
		},
	},
	{
		id: '__directus_polygons',
		type: 'fill',
		source: '__directus',
		filter: ['all', ['!has', 'point_count'], ['==', '$type', 'Polygon']],
		paint: {
			'fill-color': [
				'case',
				['boolean', ['feature-state', 'selected'], false],
				yellow,
				['boolean', ['feature-state', 'hovered'], false],
				yellow,
				green,
			],
			'fill-opacity': 0.15,
		},
	},
	{
		id: '__directus_lines',
		type: 'line',
		source: '__directus',
		filter: ['all', ['!has', 'point_count'], ['==', '$type', 'LineString']],
		paint: {
			'line-color': [
				'case',
				['boolean', ['feature-state', 'selected'], false],
				orange,
				['boolean', ['feature-state', 'hovered'], false],
				orange,
				green,
			],
			'line-width': 2,
		},
	},
	{
		id: '__directus_points_shadow',
		type: 'circle',
		source: '__directus',
		filter: ['all', ['!has', 'point_count'], ['==', '$type', 'Point']],
		layout: {},
		paint: {
			'circle-radius': 10,
			'circle-blur': 1,
			'circle-opacity': 0.9,
			'circle-color': black,
		},
	},
	{
		id: '__directus_points',
		type: 'circle',
		source: '__directus',
		filter: ['all', ['!has', 'point_count'], ['==', '$type', 'Point']],
		layout: {},
		paint: {
			'circle-radius': 6,
			'circle-color': [
				'case',
				['boolean', ['feature-state', 'selected'], false],
				orange,
				['boolean', ['feature-state', 'hovered'], false],
				orange,
				green,
			],
			'circle-stroke-color': white,
			'circle-stroke-width': 2,
		},
	},
	{
		id: '__directus_clusters',
		type: 'circle',
		source: '__directus',
		filter: ['has', 'point_count'],
		paint: {
			'circle-radius': ['step', ['get', 'point_count'], 20, 100, 30, 750, 40],
			'circle-color': ['step', ['get', 'point_count'], '#7fe3ca', 100, '#fde2a7', 750, '#f0a7b3'],
			'circle-opacity': 0.7,
		},
	},
	{
		id: '__directus_cluster_count',
		type: 'symbol',
		source: '__directus',
		filter: ['has', 'point_count'],
		layout: {
			'text-field': '{point_count_abbreviated}',
			'text-font': ['Open Sans Semibold'],
			'text-size': ['step', ['get', 'point_count'], 15, 100, 17, 750, 19],
		},
		paint: {
			'text-opacity': 0.85,
		},
	},
];
