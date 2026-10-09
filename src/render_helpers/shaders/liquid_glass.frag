#version 100

//_DEFINES_

#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif

precision highp float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif

uniform float alpha;
varying vec2 v_coords;

#if defined(DEBUG_FLAGS)
uniform float tint;
#endif

uniform float niri_scale;

uniform vec2 geo_size;
uniform vec4 corner_radius;
uniform mat3 input_to_geo;

// Liquid glass: how far the rim bends the background (1 is a 20 px pull), how much the bend
// splits the colors, and how bright the edge hairline is. All in [0, 1].
uniform float refraction;
uniform float dispersion;
uniform float specular;
// Width in pixels of the refracting band along the edge.
uniform float thickness;
// Edges joined to another surface (left, top, right, bottom), 1 or 0. The lens treats the glass
// as carrying on past them, so it does not bend there and the two surfaces read as one pane.
uniform vec4 seam;

float niri_rounding_alpha(vec2 coords, vec2 size, vec4 corner_radius);
vec4 postprocess(vec4 color);

// Signed distance to the rounded geometry, negative inside. p is in geometry pixels. Joined
// edges are pushed out past the lens band and the corners touching them are made square.
float geo_sdf(vec2 p) {
    float ext = thickness + 8.0;
    vec2 lo = -seam.xy * ext;
    vec2 hi = geo_size + seam.zw * ext;
    vec2 half_size = (hi - lo) * 0.5;
    vec2 c = p - (lo + hi) * 0.5;

    // corner_radius is top-left, top-right, bottom-right, bottom-left.
    vec4 radius = corner_radius * (1.0 - max(seam, seam.yzwx));
    float r = c.x < 0.0
        ? (c.y < 0.0 ? radius.x : radius.w)
        : (c.y < 0.0 ? radius.y : radius.z);
    r = min(r, min(half_size.x, half_size.y));

    vec2 q = abs(c) - half_size + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
    vec3 coords_geo = input_to_geo * vec3(v_coords, 1.0);
    vec2 p = coords_geo.xy * geo_size;

    // The lens lives in a band along the edge, narrower on small surfaces; the centre stays
    // clear.
    float rim = max(1.0, min(thickness, 0.45 * min(geo_size.x, geo_size.y)));
    float d = geo_sdf(p);
    // 1 at the edge, falling to 0 one rim width inside.
    float t = clamp(1.0 + d / rim, 0.0, 1.0);

    // Outward normal from the distance field.
    vec2 e = vec2(0.5, 0.0);
    vec2 n = vec2(geo_sdf(p + e.xy) - geo_sdf(p - e.xy), geo_sdf(p + e.yx) - geo_sdf(p - e.yx));
    float n_len = length(n);
    n = n_len > 0.0 ? n / n_len : vec2(0.0);

    // Pull the sample inward along the normal, weighted by a steep power of the rim ramp so
    // almost all bending happens in the outer ring; taper off over the last 2 px so the very
    // edge does not smear.
    float bend = t * t * t * smoothstep(0.0, 2.0, -d);
    // A thicker rim bends further: refraction 1 pulls by 0.6 of the rim width.
    vec2 offset_geo = -n * bend * refraction * 0.6 * rim / geo_size;

    // Back from geometry space to texture coordinates through the inverse of the linear
    // part of input_to_geo.
    mat2 a = mat2(input_to_geo[0].xy, input_to_geo[1].xy);
    float det = a[0][0] * a[1][1] - a[1][0] * a[0][1];
    mat2 to_tex = det != 0.0 ? mat2(a[1][1], -a[0][1], -a[1][0], a[0][0]) / det : mat2(0.0);
    vec2 offset_tex = to_tex * offset_geo;

    // Barely any frost (a lens, not milk): a small ring of taps about 1.5 px wide.
    vec2 sx = to_tex * vec2(1.5 / geo_size.x, 0.0);
    vec2 sy = to_tex * vec2(0.0, 1.5 / geo_size.y);
    vec2 c = v_coords + offset_tex;
    vec4 color = texture2D(tex, c) * 0.2
        + (texture2D(tex, c + sx) + texture2D(tex, c - sx)
            + texture2D(tex, c + sy) + texture2D(tex, c - sy)) * 0.15
        + (texture2D(tex, c + (sx + sy) * 0.7) + texture2D(tex, c - (sx + sy) * 0.7)
            + texture2D(tex, c + (sx - sy) * 0.7) + texture2D(tex, c - (sx - sy) * 0.7)) * 0.05;

    // Color split only where the glass bends, and kept subtle.
    if (dispersion > 0.0) {
        float k = 0.12 * dispersion;
        color.r = mix(color.r, texture2D(tex, c + offset_tex * k).r, bend);
        color.b = mix(color.b, texture2D(tex, c - offset_tex * k).b, bend);
    }
#if defined(NO_ALPHA)
    color = vec4(color.rgb, 1.0);
#endif

    color = postprocess(color);

    // Hairline highlight: about 1.5 px at the very edge, on the top and bottom sides (the top
    // brighter), fading out along the vertical sides. No glow spreading inward.
    if (specular > 0.0) {
        float hairline = 1.0 - smoothstep(0.0, 1.5, -d);
        float top = max(-n.y, 0.0);
        float bottom = max(n.y, 0.0) * 0.4;
        float s = hairline * (top + bottom) * specular * 0.6;
        color.rgb += vec3(s) * color.a;
    }

    if (coords_geo.x < 0.0 || 1.0 < coords_geo.x || coords_geo.y < 0.0 || 1.0 < coords_geo.y) {
        // Clip outside geometry.
        color = vec4(0.0);
    } else {
        // Apply corner rounding inside geometry.
        color = color * niri_rounding_alpha(p, geo_size, corner_radius);
    }

    // Apply final alpha and tint.
    color = color * alpha;

#if defined(DEBUG_FLAGS)
    if (tint == 1.0)
        color = vec4(0.0, 0.2, 0.0, 0.2) + color * 0.8;
#endif

    gl_FragColor = color;
}
