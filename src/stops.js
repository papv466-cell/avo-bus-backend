// Paradas de la línea M135
// Fuente: paradas_m135.csv proporcionado por Avo Group
// COD_ENRUTA: 4, COD_SERV_REITERACION: 544405

const STOPS_M135 = [
  { orden: 1,  nombre: "Santa Amalia",                              lat: 36.705631, lon: -4.567568 },
  { orden: 2,  nombre: "Gasolinera Sta. Amalia",                    lat: 36.705293, lon: -4.573847 },
  { orden: 3,  nombre: "Arroyo Gragea",                             lat: 36.700732, lon: -4.569514 },
  { orden: 4,  nombre: "Cuatro Vientos",                            lat: 36.697888, lon: -4.566423 },
  { orden: 5,  nombre: "El Romeral",                                lat: 36.691535, lon: -4.567213 },
  { orden: 6,  nombre: "Centro Social El Romeral",                  lat: 36.686979, lon: -4.569475 },
  { orden: 7,  nombre: "Lagar Las Pitas",                           lat: 36.685327, lon: -4.570865 },
  { orden: 8,  nombre: "Torrealqueria",                             lat: 36.689655, lon: -4.598674 },
  { orden: 9,  nombre: "Entrada Torrealqueria",                     lat: 36.687727, lon: -4.597795 },
  { orden: 10, nombre: "Sol Andalusí",                              lat: 36.675064, lon: -4.595675 },
  { orden: 11, nombre: "Centro Penitenciario",                      lat: 36.672390, lon: -4.585317 },
  { orden: 12, nombre: "Urbanización Peralta",                      lat: 36.664888, lon: -4.584660 },
  { orden: 13, nombre: "Viña Grande",                               lat: 36.657417, lon: -4.574941 },
  { orden: 14, nombre: "Calabuch",                                  lat: 36.659434, lon: -4.569278 },
  { orden: 15, nombre: "Alhaurín de la Torre",                      lat: 36.660303, lon: -4.563033 },
  { orden: 16, nombre: "Ermita del Cerro",                          lat: 36.664529, lon: -4.556832 },
  { orden: 17, nombre: "Barriada el Cordobés",                      lat: 36.667487, lon: -4.559686 },
  { orden: 18, nombre: "Polígono Industrial",                       lat: 36.673441, lon: -4.550662 },
  { orden: 19, nombre: "Paredillas",                                lat: 36.676982, lon: -4.544822 },
  { orden: 20, nombre: "Redonda del Peñón",                         lat: 36.682808, lon: -4.537368 },
  { orden: 21, nombre: "Peñón",                                     lat: 36.683280, lon: -4.534572 },
  { orden: 22, nombre: "Puertalahaurín",                            lat: 36.685866, lon: -4.529405 },
  { orden: 23, nombre: "Zapata",                                    lat: 36.687706, lon: -4.522872 },
  { orden: 24, nombre: "Terminal De Carga",                         lat: 36.684187, lon: -4.499570 },
  { orden: 25, nombre: "Aeropuerto",                                lat: 36.678494, lon: -4.492532 },
  { orden: 26, nombre: "Porcelanosa",                               lat: 36.694070, lon: -4.452860 },
  { orden: 27, nombre: "Av. de Velázquez, 61",                      lat: 36.695992, lon: -4.450428 },
  { orden: 28, nombre: "Paseo de los Tilos - Estación de Autobuses",lat: 36.713332, lon: -4.433934 },
];

module.exports = { STOPS_M135 };
