#include <Adafruit_NeoPixel.h>
#include "timeline.h"

#define LEDS_PER_PRINTER 2
#define BRIGHTNESS 35

// MKR1010 13 * data pin
const uint8_t pins[NUM_PRINTERS] = {
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  A0,
  A1,
  A2,
  A3
};

Adafruit_NeoPixel strips[NUM_PRINTERS] = {
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 2, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 3, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 4, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 5, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 6, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 7, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 8, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 9, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 10, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, A0, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, A1, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, A2, NEO_GRB + NEO_KHZ800),
  Adafruit_NeoPixel(LEDS_PER_PRINTER, A3, NEO_GRB + NEO_KHZ800)
};

uint32_t getColor(uint8_t state, Adafruit_NeoPixel &strip) {
  switch (state) {
    case 0: return strip.Color(35, 35, 35);    // Offline = dim white
    case 1: return strip.Color(0, 0, 120);     // Ready = blue
    case 2: return strip.Color(0, 120, 0);     // Printing = green
    case 3: return strip.Color(120, 80, 0);    // Paused/Warning = yellow
    case 4: return strip.Color(120, 0, 0);     // Error = red
    default: return strip.Color(0, 0, 0);
  }
}

void setPrinter(uint8_t printerIndex, uint8_t state) {
  uint32_t color = getColor(state, strips[printerIndex]);

  for (int i = 0; i < LEDS_PER_PRINTER; i++) {
    strips[printerIndex].setPixelColor(i, color);
  }

  strips[printerIndex].show();
}

void clearAll() {
  for (uint8_t p = 0; p < NUM_PRINTERS; p++) {
    strips[p].clear();
    strips[p].show();
  }
}

void startSignal() {
  for (int flash = 0; flash < 2; flash++) {
    for (uint8_t p = 0; p < NUM_PRINTERS; p++) {
      for (int i = 0; i < LEDS_PER_PRINTER; i++) {
        strips[p].setPixelColor(i, strips[p].Color(120, 120, 120));
      }
      strips[p].show();
    }

    delay(300);
    clearAll();
    delay(300);
  }
}

void setup() {
  for (uint8_t p = 0; p < NUM_PRINTERS; p++) {
    strips[p].begin();
    strips[p].setBrightness(BRIGHTNESS);
    strips[p].show();
  }
}

void loop() {
  startSignal();

  for (int frame = 0; frame < NUM_FRAMES; frame++) {
    for (uint8_t printer = 0; printer < NUM_PRINTERS; printer++) {
      uint8_t state = timeline[frame][printer];
      setPrinter(printer, state);
    }

    delay(frameDuration[frame]);
  }

  delay(1000);
}
