/* Project fixture generator. Build against the unchanged upstream reference. */
#include <stdio.h>
#include <inttypes.h>
#include "xoshiro128starstar.c"

int main(void) {
    const uint32_t seeds[][4] = {
        {1, 2, 3, 4},
        {UINT32_MAX, UINT32_C(0x80000000), UINT32_C(0x12345678), 1}
    };
    printf("{\"algorithm\":\"xoshiro128ss-reference-1.1\",\"vectors\":[");
    for (int row = 0; row < 2; row++) {
        if (row) printf(",");
        printf("{\"state\":[");
        for (int i = 0; i < 4; i++) {
            s[i] = seeds[row][i];
            printf("%s%" PRIu32, i ? "," : "", s[i]);
        }
        printf("],\"outputs\":[");
        for (int i = 0; i < 16; i++) printf("%s%" PRIu32, i ? "," : "", next());
        printf("]}");
    }
    printf("]}\n");
    return 0;
}
