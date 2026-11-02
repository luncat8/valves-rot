[partially solved, but behavior still not as good lok as GLM prototype]

physics bug or not desired behavior: if pipe filled with grains them block movement and somehow prevent to me moved by gravity or pressure. this may be mean physics is good and count friction but also may be bug. anyway this cause grains not roll as it should but stack and block L shaped pipes , made impossible to route them to target. ned to fix or add some 'lubricant' literally saying. so it will roll good even when pipe is full of grains.


previous attempts did not solved task:
single grains still sit on the slope surface without move and on L shaped pipe, etc. also noise was not removed. probably need to remove old wrong approaches and implement better.

commit 656ee38b1a9b98695d1157b0b99990ac210f7ae2

with

archive/lubricant-worklog.md

this improve situation but not solve root of problem. also this make it behavior noisy.

(you can fetch whole commit from gh or previous if you found it is not good and better start from previous point and refactor)

see experiments/logs/bug-roll.webp

we have only few single grains that sit on slope surface and not roll as expected. this could mean: geometry if wrong, mass is less then friction, other solver issue. we fight this from the start of combined project without big success.

GLM and GP

the task for previous session was:

i see physics bug or not desired behavior: if pipe filled with grains them block movement and somehow prevent to me moved by gravity or pressure. this may be mean physics is good and count friction but also may be bug. anyway this cause grains not roll as it should but stack and block L shaped pipes , made impossible to route them to target. ned to fix or add some 'lubricant' literally saying. so it will roll good even when pipe is full of grains.