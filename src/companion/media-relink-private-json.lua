-- Private protocol JSON. Paths and error text are data, never public DTOs.
local NULL={};local ARRAY={}
local function array(value)return setmetatable(value or {},ARRAY)end
local function quote(value)
 assert(type(value)=='string'and #value<=32768,'Private string bound')
 return '"'..value:gsub('[%z\1-\31\127\\"]',function(c)
  if c=='"'then return '\\"'elseif c=='\\'then return '\\\\'else return string.format('\\u%04x',string.byte(c))end
 end)..'"'
end
local function encode(value,depth)
 depth=depth or 0;assert(depth<=24,'Private JSON depth')
 if value==NULL or value==nil then return 'null'end
 local kind=type(value)
 if kind=='string'then return quote(value)end
 if kind=='boolean'then return value and 'true'or'false'end
 if kind=='number'then assert(value==value and value~=math.huge and value~=-math.huge,'Private number invalid');return tostring(value)end
 assert(kind=='table','Private JSON type')
 local parts={}
 if getmetatable(value)==ARRAY then
  local count=0;for k in pairs(value)do assert(type(k)=='number'and k%1==0 and k>=1 and k<=10000,'Private array key');count=count+1 end;assert(count==#value,'Private array sparse')
  for index=1,#value do parts[#parts+1]=encode(value[index],depth+1)end
  return '['..table.concat(parts,',')..']'
 end
 local keys={};for key in pairs(value)do assert(type(key)=='string','Private object key');keys[#keys+1]=key end;assert(#keys<=128,'Private object bound');table.sort(keys)
 for _,key in ipairs(keys)do parts[#parts+1]=quote(key)..':'..encode(value[key],depth+1)end
 return '{'..table.concat(parts,',')..'}'
end
