# Scientific modeling that survives animation

## Physics

- Fix a coordinate system and field direction first. Compute Lorentz-force direction with q(v × B), not a visual guess. “Speed unchanged” means magnitude; velocity direction changes.
- Derive particle position, tangent velocity and force from one physical time variable. A visual easing function must not independently rotate arrows away from the actual trajectory. Label slow motion and illustrative scaling.
- Field boundaries matter. End a trajectory at its first boundary event. A later intersection of the complete circle does not describe an actual exit after motion has already entered another region.
- State what changes at a boundary: field, support force, acceleration, initial conditions. Project a 3D trajectory into a specified viewing plane; do not silently reinterpret a projected distance as the physical quantity asked for.
- Free fall with an electric field: derive the signed net acceleration. A zero or upward acceleration may invalidate a ground-impact formula for a horizontal launch.
- State endpoint conventions at corners or grazing events. Equality is not automatically included in every verbal condition.
- Numerical checks should probe both sides of each threshold, corner ties, and intermediate trajectory containment. For precision, an analytic orbit can be compared with a numerical ODE solution and conserved quantities.

## Mathematics

- Keep points on their defined curves, label domains, distinguish a limiting process from substitution into an undefined expression.
- A secant denominator approaching zero must not become an actual 0/0. If both-sided convergence matters, show or explain both sides; do not overcomplicate a lesson merely to animate every proof detail.
- Use algebra to verify geometric claims. For y=x² the gap above the tangent at a is (x−a)²; a plot alone does not establish the general result.
- For worked transfer, alter a structural parameter. Derive the general relation, specialize it to a new value, and recover the original as a consistency check.

## Physics example: square table, downward B inside, downward E outside

This is a specific tested geometry, not a general physics engine. With a=(0,0), b=(0,L), d=(L,0), positive charge entering at N=(s,0) toward +y:

`r=mv/(qB)`, circle center `(s−r,0)`, `x=s−r+r cosθ`, `y=r sinθ`.

Candidate first events: return to ad at θ=π; reach ab when cosθ=1−s/r if r≥s/2; reach bc when sinθ=L/r if r≥L. Select the smallest positive event, retaining corner ties. For 0<s<L the ab interval is `s/2 ≤ r ≤ (L²+s²)/(2s)` under the inclusive-corner convention.

At s=L/2: radii L/4 and 5L/4. At s=L/3: L/6 and 5L/3. At b, the exit velocity is horizontal and tangent to the circle, not necessarily parallel to a table edge. With A=g+qE/m>0, t=√(2h/A), R=v_b t and the straight distance from b to the landing point is √(R²+h²).
