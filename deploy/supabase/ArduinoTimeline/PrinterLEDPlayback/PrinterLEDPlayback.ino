#include <Adafruit_NeoPixel.h>
#include "timeline.h"

#define LEDS_PER_PRINTER 2
#define BRIGHTNESS 35

Adafruit_NeoPixel strips[NUM_PRINTERS] = {
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 4, NEO_GRB + NEO_KHZ800),   // CoreOne-3
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 5, NEO_GRB + NEO_KHZ800),   // H2D-01
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 6, NEO_GRB + NEO_KHZ800),   // H2D-02
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 7, NEO_GRB + NEO_KHZ800),   // H2D-03
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 8, NEO_GRB + NEO_KHZ800),   // H2D-04
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 9, NEO_GRB + NEO_KHZ800),   // XL-01
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 10, NEO_GRB + NEO_KHZ800),  // XL-02
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 2, NEO_GRB + NEO_KHZ800),   // X1C-02
  Adafruit_NeoPixel(LEDS_PER_PRINTER, 3, NEO_GRB + NEO_KHZ800),   // X1C-01
  Adafruit_NeoPixel(LEDS_PER_PRINTER, A3, NEO_GRB + NEO_KHZ800),  // CoreOne-2
  Adafruit_NeoPixel(LEDS_PER_PRINTER, A2, NEO_GRB + NEO_KHZ800),  // CoreOne-6
  Adafruit_NeoPixel(LEDS_PER_PRINTER, A1, NEO_GRB + NEO_KHZ800),  // CoreOne-4
  Adafruit_NeoPixel(LEDS_PER_PRINTER, A0, NEO_GRB + NEO_KHZ800)   // CoreOne-5
};

uint32_t getColor(uint8_t state, Adafruit_NeoPixel &strip) {
  switch (state) {
    case 0: return strip.Color(35, 35, 35);    // Offline
    case 1: return strip.Color(0, 0, 120);     // Ready
    case 2: return strip.Color(0, 120, 0);     // Printing
    case 3: return strip.Color(120, 80, 0);    // Warning
    case 4: return strip.Color(120, 0, 0);     // Error
    default: return strip.Color(0, 0, 0);
  }
}

void setAllColor(uint8_t r, uint8_t g, uint8_t b) {
  for (uint8_t p = 0; p < NUM_PRINTERS; p++) {
    uint32_t color = strips[p].Color(r, g, b);
    for (uint8_t i = 0; i < LEDS_PER_PRINTER; i++) {
      strips[p].setPixelColor(i, color);
    }
    strips[p].show();
  }
}

void clearAll() {
  setAllColor(0, 0, 0);
}

void setPrinter(uint8_t printerIndex, uint8_t state) {
  uint32_t color = getColor(state, strips[printerIndex]);
  for (uint8_t i = 0; i < LEDS_PER_PRINTER; i++) {
    strips[printerIndex].setPixelColor(i, color);
  }
  strips[printerIndex].show();
}

void whiteBreath() {
  for (int v = 0; v <= 120; v += 4) {
    setAllColor(v, v, v);
    delay(18);
  }

  for (int v = 120; v >= 0; v -= 4) {
    setAllColor(v, v, v);
    delay(18);
  }

  delay(150);
}

void flashColor(uint8_t r, uint8_t g, uint8_t b, int onTime, int offTime) {
  setAllColor(r, g, b);
  delay(onTime);
  clearAll();
  delay(offTime);
}

void startAnimation() {
  clearAll();
  delay(300);

  whiteBreath();

  // White flash
  flashColor(120, 120, 120, 250, 250);

  // Blue flash = System Ready
  flashColor(0, 0, 120, 300, 400);
}

void endAnimation() {
  // Hold the final month state
  delay(2000);

  // White flash twice
  for (int i = 0; i < 2; i++) {
    flashColor(120, 120, 120, 250, 250);
  }

  delay(500);
}

void playTimeline() {
  for (int frame = 0; frame < NUM_FRAMES; frame++) {
    for (uint8_t printer = 0; printer < NUM_PRINTERS; printer++) {
      uint8_t state = timeline[frame][printer];
      setPrinter(printer, state);
    }

    delay(frameDuration[frame]);
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
  startAnimation();
  playTimeline();
  endAnimation();
}