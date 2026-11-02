#include "math.hpp"

int main() {
  int total = add(1, 2);
  int *wrong = "not a pointer to int";
  return total + (wrong != nullptr);
}
