/**
 * --- ГОРOДСКОЙ ЭКСПОСОМ: ТЕПЛОВЫЕ ОСТРОВА ---
 * Скрипт для расчета LST (Land Surface Temperature) на основе Landsat 8/9.
 * Выполняет калибровку в Цельсии, очистку от облаков и сглаживание.
 */

// 1. Полигон Крыма (GeoJSON -> Geometry)
// ВАЖНО: Ниже сокращенный список координат для экономии места. 
// Полный GeoJSON можно взять из файла Тез.txt
var crimeaGeoJSON = { "type": "Feature", "geometry": { "type": "Polygon", "coordinates": [[[34.9775505065918, 45.762852670319745], [35.04443359375, 45.6700439453125], [35.332183837890625, 45.3712158203125], [36.638336181640625, 45.35125732421875], [36.408843994140625, 45.14947509765625], [34.475250244140625, 44.723602294921875], [33.37109375, 44.58843994140625], [32.48583984375, 45.3948974609375], [33.62039566040039, 46.136311222062865], [34.408836364746094, 46.00578560402203], [34.9775505065918, 45.762852670319745]]] } };

// 2. Инициализация региона (ROI)
var roi = ee.Feature(crimeaGeoJSON).geometry();

/**
 * Подготовка снимков: маскировка теней/облаков и расчет температуры
 */
function processImage(image) {
    var qa = image.select('QA_PIXEL');
    var mask = qa.bitwiseAnd(1 << 3).eq(0).and(qa.bitwiseAnd(1 << 4).eq(0));

    // Коэффициенты калибровки для Landsat Collection 2
    var lst = image.select('ST_B10').multiply(0.00341802).add(149.0).subtract(273.15)
        .rename('LST_Celsius');

    return image.addBands(lst).updateMask(mask);
}

// 3. Сбор коллекции (Лето 2025)
var collection = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
    .filterBounds(roi)
    .filterDate('2025-06-01', '2025-08-31')
    .map(processImage);

// 4. Расчет медианы и финальное сглаживание (убираем резкие края пикселей)
var finalMap = collection.select('LST_Celsius')
    .median()
    .clip(roi)
    .focal_mean({ radius: 200, units: 'meters' });

// 5. Визуализация (сине-красная палитра)
var visual = {
    min: 20,
    max: 45,
    palette: ['blue', 'cyan', 'green', 'yellow', 'red']
};

Map.centerObject(roi, 8);
Map.addLayer(finalMap, visual, 'Thermal Map Crimea (LST)', true, 0.65);

// 6. Экспорт результата в облако
Export.image.toDrive({
    image: finalMap,
    description: 'Crimea_LST_2025_Export',
    folder: 'GEE_AL_Analytic',
    fileNamePrefix: 'crimea_lst_smooth',
    scale: 250, // Оптимально для сайта
    region: roi,
    maxPixels: 1e13
});
