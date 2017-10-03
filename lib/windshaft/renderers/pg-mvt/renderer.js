var Timer = require('../../stats/timer');
var debug = require('debug')('windshaft:renderer:pg_mvt');
var SubstitutionTokens = require('../../utils/substitution_tokens');
var geojsonUtils = require('../../utils/geojson_utils');

/// CLASS: pg_mvt Renderer
//
/// A renderer for a given MapConfig layer
///
function Renderer(layers, sql, attrs, options) {
    options = options || {};

    this.sql = sql;
    this.attrs = attrs;
    this.layers = layers;

    this.tile_size = options.tileSize || 256;
    this.tile_max_geosize = options.maxGeosize || 40075017; // earth circumference in webmercator 3857
    this.buffer_size = options.bufferSize || 0;
    this.mvt_extent = options.mvt_extent || 4096;
}

module.exports = Renderer;


Renderer.prototype = {
    /// API: renders a tile with the Renderer configuration
    /// @param x tile x coordinate
    /// @param y tile y coordinate
    /// @param z tile zoom
    /// callback: will be called when done using nodejs protocol (err, data)
    getTile: function (z, x, y, callback) {
        var query = 'SELECT (';
        this.layers.forEach((layer, i) => {
            if (i >= 1) {
                query += ' || ';
            }
            var nonGeoColumns = geojsonUtils.getGeojsonProperties(layer.options).join(',');
            if (nonGeoColumns !== '') {
                nonGeoColumns += ',';
            }

            var subQuery = SubstitutionTokens.replace(layer.options.sql, {
                bbox: `CDB_XYZ_Extent(${x},${y},${z})`,
                // See https://github.com/mapnik/mapnik/wiki/ScaleAndPpi#scale-denominator
                scale_denominator: `(cdb_XYZ_Resolution(${z}) / 0.00028)`,
                pixel_width: `cdb_XYZ_Resolution(${z})`,
                pixel_height: `cdb_XYZ_Resolution(${z})`,
                var_zoom: z,
                var_x: x,
                var_y: y
            });

            query += `(
                select st_asmvt(geom, '${layer.id}') FROM
                (SELECT ${nonGeoColumns}
                    ST_AsMVTGeom(the_geom_webmercator, CDB_XYZ_Extent(${x},${y},${z}), ${this.mvt_extent}, 0, true)
                FROM
                    (${subQuery}) AS cdbq where the_geom_webmercator && CDB_XYZ_Extent(${x},${y},${z}) )
                    AS geom
                )`;
        });
        query += ') AS st_asmvt';

        var timer = new Timer();
        timer.start('query');
        this.sql(query, function (err, data) {
            timer.end('query');
            if (err) {
                debug("Error running pg_mvt query " + query + ": " + err);
                if (err.message) {
                    err.message = "PgMvtRenderer: " + err.message;
                }
                callback(err);
            } else {
                if (data.rows.length <= 0 || data.rows[0].st_asmvt===undefined){
                    return callback(new Error(`Couldn't generate tile`));
                }
                callback(null, data.rows[0].st_asmvt, { 'Content-Type': 'application/x-protobuf' }, timer.getTimes());
            }
        });
    }
};